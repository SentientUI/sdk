import { classifySection, SEMANTIC_TYPES, type SemanticType } from './classify';
import { isDoNotTrackEnabled } from '../index.js';
import { attachMicroSignalDetectors } from '../micro-signals.js';

// Shared engagement capture (spec 2026-07-22-persona-signal-capture). Detects
// semantic sections, registers them via /v1/section-map, and records per-section
// dwell/scroll via IntersectionObserver — emitting the same 'dwell' events the
// persona pipeline consumes. Used by the React provider (default on) and the
// no-code snippet. Defense-in-depth: checks DNT internally even though callers
// gate on consent/DNT too; a missing IntersectionObserver → no-op.

type CaptureClient = {
  track(event: { projectId: string; componentId: string; eventType: string; payload: Record<string, unknown> }): void;
};

export type EngagementCaptureOptions = {
  apiKey: string;
  /** API base, no trailing slash. Defaults to the hosted API. */
  apiBase?: string;
  doc?: Document;
  /**
   * Also attach per-section micro-signal detectors (rage click, text copy,
   * scroll hesitation, tab loss), attributed to the section's `nc-<type>`
   * component. For the no-code snippet, whose pages have no `<Adaptive>`
   * components carrying their own detectors. Default false — the React SDK
   * keeps its per-component detectors and must not double-attach.
   */
  microSignals?: boolean;
  /**
   * Server-served section-map lookup (persona-coverage auto-classification):
   * consulted after explicit `data-sentient-type` markup, before the local
   * heuristic. Return null when the element has no served label.
   */
  typeOf?: (el: Element) => SemanticType | null;
};

const SECTION_SELECTOR = 'section, header, footer, nav, main > div, [data-sentient-section]';

/** Skip a section nested inside another candidate section (avoid double count). */
function isNested(el: Element): boolean {
  return el.parentElement?.closest(SECTION_SELECTOR) != null;
}

function registerSections(
  apiKey: string,
  apiBase: string,
  pageUrl: string,
  sections: Array<{ componentId: string; semanticType: SemanticType; source: 'markup' | 'auto' }>,
): void {
  try {
    void fetch(`${apiBase}/v1/section-map`, {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ pageUrl, sections }),
    }).catch(() => undefined);
  } catch {
    /* fail-safe */
  }
}

const NOOP = (): void => undefined;

export function startEngagementCapture(
  client: CaptureClient,
  opts: EngagementCaptureOptions,
): () => void {
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!doc || typeof IntersectionObserver === 'undefined') return NOOP;
  if (isDoNotTrackEnabled()) return NOOP;
  // Keyless zero-network contract: capture exists to feed the hosted persona
  // pipeline — with no api key there is nothing to feed, and the section-map
  // registration fetch must never fire.
  if (!opts.apiKey) return NOOP;
  // Normalize so both a ROOT base (`https://api.sentient-ui.com`) and a
  // `/v1`-suffixed base resolve to exactly one `/v1/section-map` — some callers
  // pass the versioned base, which would otherwise produce `/v1/v1/section-map`
  // (a silent 404). Strip trailing slashes, then a single trailing `/v1`.
  const apiBase = (opts.apiBase ?? 'https://api.sentient-ui.com')
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '');

  const els = Array.from(doc.querySelectorAll(SECTION_SELECTOR)).filter((el) => !isNested(el));
  if (els.length === 0) return NOOP;

  // Collapse to one component per semantic type per page (the matrix aggregates
  // by semantic type anyway). Per-element precedence: explicit data-sentient-type
  // markup → served section map (opts.typeOf) → local heuristic.
  const componentOf = new Map<Element, string>();
  const types = new Map<string, SemanticType>();
  const sources = new Map<string, 'markup' | 'auto'>();
  for (const el of els) {
    const explicit = el.getAttribute('data-sentient-type');
    const markup = explicit && (SEMANTIC_TYPES as readonly string[]).includes(explicit)
      ? (explicit as SemanticType)
      : null;
    const type = markup ?? opts.typeOf?.(el) ?? classifySection(el);
    const componentId = `nc-${type}`;
    componentOf.set(el, componentId);
    types.set(componentId, type);
    // Markup wins if the same collapsed component gets both provenances.
    if (markup) sources.set(componentId, 'markup');
    else if (!sources.has(componentId)) sources.set(componentId, 'auto');
  }

  const pageUrl = (doc.defaultView ?? (typeof window !== 'undefined' ? window : undefined))?.location?.pathname ?? '/';
  registerSections(opts.apiKey, apiBase, pageUrl, [...types.entries()].map(([componentId, semanticType]) => ({
    componentId, semanticType, source: sources.get(componentId) ?? 'auto',
  })));

  // Accumulate visible dwell (ms) + max scroll ratio per component. `intersecting`
  // tracks in-viewport state independently of `enterAt` (the running clock) so a
  // tab-hide can pause the clock and a tab-show can resume it for still-visible
  // sections — IntersectionObserver does not re-fire on visibilitychange.
  const state = new Map<string, { ms: number; scroll: number; enterAt: number | null; intersecting: boolean }>();
  const get = (id: string) => {
    let s = state.get(id);
    if (!s) { s = { ms: 0, scroll: 0, enterAt: null, intersecting: false }; state.set(id, s); }
    return s;
  };

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const id = componentOf.get(entry.target);
      if (!id) continue;
      const s = get(id);
      if (entry.isIntersecting) {
        s.intersecting = true;
        s.enterAt = Date.now();
        if (entry.intersectionRatio > s.scroll) s.scroll = entry.intersectionRatio;
      } else {
        s.intersecting = false;
        if (s.enterAt != null) { s.ms += Date.now() - s.enterAt; s.enterAt = null; }
      }
    }
  }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
  for (const el of componentOf.keys()) observer.observe(el);

  // Bank accumulated dwell and RESET the accumulators (so a later emit can't
  // double-count) WITHOUT disconnecting — a visitor who hides/re-shows the tab
  // or tab-switches keeps being measured. Pauses the running clock; the tab-show
  // handler restarts it for still-visible sections so hidden time isn't counted.
  const emit = (): void => {
    const now = Date.now();
    for (const [id, s] of state) {
      if (s.enterAt != null) { s.ms += now - s.enterAt; s.enterAt = null; }
      if (s.ms <= 0) continue;
      try {
        client.track({
          projectId: opts.apiKey, // SDK convention: server derives the real project from the key
          componentId: id,
          eventType: 'dwell',
          payload: { dwell_time: Math.round(s.ms), scroll_depth: Number(s.scroll.toFixed(2)) },
        });
      } catch {
        /* fail-safe */
      }
      s.ms = 0;
    }
  };

  const onVisibility = (): void => {
    if (doc.hidden) {
      emit(); // bank + pause
    } else {
      const now = Date.now(); // resume the clock for sections still on screen
      for (const s of state.values()) if (s.intersecting) s.enterAt = now;
    }
  };
  const onPageHide = (): void => {
    emit();
    try { observer.disconnect(); } catch { /* ignore */ }
  };
  doc.addEventListener('visibilitychange', onVisibility);
  const win = doc.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
  win?.addEventListener('pagehide', onPageHide);

  // Per-section micro-signal detectors (opt-in; see EngagementCaptureOptions).
  // Attributed to the section's nc-<type> id with no variant — they feed the
  // persona attention fallback and auto-discovery, never rewards.
  const detectorCleanups: Array<() => void> = [];
  if (opts.microSignals) {
    // tab_loss is a single document-level `visibilitychange` signal, so enabling
    // it on every section detector would emit one tab_loss per nc-<type> section
    // on a single tab-hide — attributing one page-level exit to every section
    // (audit M5). Enable it on only the first section so the exit is recorded
    // once, mirroring the per-option path in slot-signals.ts ({ tabLoss: index === 0 }).
    [...componentOf.entries()].forEach(([el, componentId], i) => {
      detectorCleanups.push(
        attachMicroSignalDetectors((signalType, extra = {}) => {
          try {
            client.track({
              projectId: opts.apiKey,
              componentId,
              eventType: 'micro_signal',
              payload: { signalType, ...extra },
            });
          } catch {
            /* fail-safe */
          }
        }, el, undefined, { tabLoss: i === 0 }),
      );
    });
  }

  // Cleanup: bank any remaining dwell, then detach everything (provider unmount
  // / consent re-init must not leak observers or listeners).
  return () => {
    emit();
    doc.removeEventListener('visibilitychange', onVisibility);
    win?.removeEventListener('pagehide', onPageHide);
    for (const c of detectorCleanups) c();
    try { observer.disconnect(); } catch { /* ignore */ }
  };
}
