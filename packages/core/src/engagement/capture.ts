import {
  classifyFeatures,
  featuresFromElement,
  CONTENT_PATTERNS,
  SEMANTIC_TYPES,
  type SemanticType,
} from './classify';
import { fnv1a } from '@sentientui/policy';
import { isDoNotTrackEnabled } from '../index.js';
import { attachMicroSignalDetectors } from '../micro-signals.js';
import { locatorFromElement } from '../locator-from-dom.js';

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
   * scroll hesitation, tab loss), attributed to the section's per-element `nc-*`
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

/** Bank cadence for visible dwell. Dwell used to leave the page only on
 *  visibilitychange/pagehide, and in production that path delivered for ~5-8%
 *  of sessions (Bodyshop audit 2026-08-30): a visitor who reads and closes the
 *  tab races the unload pipeline, and mobile browsers can kill a page with no
 *  lifecycle event at all. The heartbeat caps the loss at one interval. */
const HEARTBEAT_MS = 20_000;

/**
 * Pick the elements to observe. Two rules, in order:
 * 1. A candidate that CONTAINS two or more other candidates is a layout
 *    wrapper, not a section — drop it. Pages built from bare divs match
 *    `main > div` with their page-wide content wrapper; keeping that outer
 *    match swallowed every real <section> inside it, collapsing the whole page
 *    into one nc-generic component whose intersectionRatio could never exceed
 *    viewport-height / page-height (a constant ~0.05 scroll_depth on the
 *    audited site). A candidate with exactly one nested candidate (header >
 *    nav) is NOT a wrapper — rule 2 keeps the outer one, as before.
 * 2. Of what remains, skip a section nested inside another kept section
 *    (avoid double count).
 */
function selectSections(doc: Document): Element[] {
  const candidates = Array.from(doc.querySelectorAll(SECTION_SELECTOR));
  const kept = candidates.filter(
    (el) => candidates.filter((c) => c !== el && el.contains(c)).length < 2,
  );
  return kept.filter((el) => !kept.some((k) => k !== el && k.contains(el)));
}

/** Client-sensor observation riding each section-map entry (spec 2026-09-04
 *  §2): structure, headings, and which CONTENT_PATTERNS matched — never body
 *  text, so nothing beyond headings leaves the page. Lets the server's richer
 *  topic classifier label pages the crawler cannot fetch (CSR, auth-walled). */
type SectionObservation = {
  tag: string;
  idClass: string;
  headingText: string;
  textLength: number;
  actionCount: number;
  ariaRole?: string;
  patternFlags?: SemanticType[];
};

function registerSections(
  apiKey: string,
  apiBase: string,
  pageUrl: string,
  sections: Array<{
    componentId: string;
    semanticType: SemanticType;
    source: 'markup' | 'auto';
    locator?: unknown;
    observation?: SectionObservation;
  }>,
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
  // registration fetch must never fire. Same validity rule as init() and the
  // graph entry: this used to check truthiness only, so an invalid non-`pk_`
  // (typo'd) key still fired /v1/section-map registration and dwell events
  // into a client that discards everything.
  if (!opts.apiKey || !opts.apiKey.startsWith('pk_')) return NOOP;
  // Normalize so both a ROOT base (`https://api.sentient-ui.com`) and a
  // `/v1`-suffixed base resolve to exactly one `/v1/section-map` — some callers
  // pass the versioned base, which would otherwise produce `/v1/v1/section-map`
  // (a silent 404). Strip trailing slashes, then a single trailing `/v1`.
  const apiBase = (opts.apiBase ?? 'https://api.sentient-ui.com')
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '');

  const els = selectSections(doc);
  if (els.length === 0) return NOOP;

  // One component per ELEMENT (nc-* retirement, 2026-09-05): the id carries a
  // short locator hash — `nc-<type>-<hash>` — so two same-typed bands no longer
  // collapse into one row with summed dwell, which is what made "which features
  // band holds attention?" unanswerable. The hash is over the locator's
  // identity fields (the same subset section_key hashes server-side), so the id
  // is stable across visits. An element with no resolvable locator falls back
  // to the collapsed `nc-<type>` — no identity means no better name exists.
  // The type-level matrix is unaffected (it aggregates via graph_nodes
  // semantic_type); pre-change dwell history stays keyed to collapsed ids and
  // ages out of the reporting windows.
  // Per-element precedence: explicit data-sentient-type markup → served
  // section map (opts.typeOf) → local heuristic.
  const componentOf = new Map<Element, string>();
  const entries: Array<{
    componentId: string;
    semanticType: SemanticType;
    source: 'markup' | 'auto';
    locator?: unknown;
    observation?: SectionObservation;
  }> = [];
  for (const el of els) {
    const explicit = el.getAttribute('data-sentient-type');
    const markup = explicit && (SEMANTIC_TYPES as readonly string[]).includes(explicit)
      ? (explicit as SemanticType)
      : null;
    const f = featuresFromElement(el);
    const type = markup ?? opts.typeOf?.(el) ?? classifyFeatures(f).type;
    const locator = locatorFromElement(el, doc) as
      | { id?: string; dataAttr?: unknown; selector?: string }
      | null;
    const componentId = locator
      ? `nc-${type}-${fnv1a(
          JSON.stringify({ id: locator.id ?? null, dataAttr: locator.dataAttr ?? null, selector: locator.selector ?? null }),
        ).toString(36)}`
      : `nc-${type}`;
    componentOf.set(el, componentId);
    // Client-sensor observation: which shipped CONTENT_PATTERNS matched the
    // body text (booleans — the text itself never leaves the page), plus the
    // structural features the server classifier keys on.
    const patternFlags = CONTENT_PATTERNS.filter(([, re]) => re.test(f.bodyText)).map(([t]) => t);
    entries.push({
      componentId,
      semanticType: type,
      // `source` is per ELEMENT: with one row per section the server records
      // each section's real provenance, not the most-confident of its siblings'.
      source: markup ? 'markup' : 'auto',
      ...(locator ? { locator } : {}),
      observation: {
        tag: f.tag,
        idClass: f.idClass.slice(0, 200),
        headingText: f.headingText,
        textLength: f.textLength,
        actionCount: f.actionCount,
        ...(f.ariaRole ? { ariaRole: f.ariaRole } : {}),
        ...(patternFlags.length > 0 ? { patternFlags } : {}),
      },
    });
  }

  const pageUrl = (doc.defaultView ?? (typeof window !== 'undefined' ? window : undefined))?.location?.pathname ?? '/';
  registerSections(opts.apiKey, apiBase, pageUrl, entries);

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
  // A page can be FROZEN into the bfcache rather than torn down. Timers keep
  // firing on restore, and `intersecting` still holds whatever it held at
  // pagehide — so without this the heartbeat kept banking dwell for sections the
  // visitor had scrolled far past, forever, while the observer that could have
  // corrected them had been disconnected. Freeze the clocks instead, and only
  // tear down for real when the page is genuinely going away.
  let frozen = false;
  const onPageHide = (event?: { persisted?: boolean }): void => {
    emit(); // bank whatever is measured either way
    if (event?.persisted) {
      frozen = true; // bfcache: keep the observer, stop counting
      return;
    }
    try { observer.disconnect(); } catch { /* ignore */ }
  };
  const onPageShow = (event?: { persisted?: boolean }): void => {
    if (!event?.persisted || !frozen) return;
    frozen = false;
    // The observer stayed connected, so it will correct `intersecting` for
    // anything that moved. Restart clocks only for what is on screen NOW.
    const now = Date.now();
    for (const s of state.values()) s.enterAt = s.intersecting && !doc.hidden ? now : null;
  };
  doc.addEventListener('visibilitychange', onVisibility);
  const win = doc.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
  win?.addEventListener('pagehide', onPageHide);
  win?.addEventListener('pageshow', onPageShow);

  // See HEARTBEAT_MS: bank visible dwell periodically so a hard close (or a
  // mobile page kill) loses at most one interval instead of the whole visit.
  // Hidden tabs skip the emit — their clock is already paused, and an empty
  // state map makes emit a no-op anyway.
  const heartbeat = setInterval(() => {
    if (doc.hidden || frozen) return;
    emit();
    // emit() pauses every running clock and only the tab-show handler restarts
    // them — here the page never went hidden, so restart the clock ourselves
    // or accumulation silently stops after the first heartbeat.
    const now = Date.now();
    for (const s of state.values()) if (s.intersecting) s.enterAt = now;
  }, HEARTBEAT_MS);

  // Per-section micro-signal detectors (opt-in; see EngagementCaptureOptions).
  // Attributed to the section's per-element nc-* id with no variant — they feed the
  // persona attention fallback and auto-discovery, never rewards.
  const detectorCleanups: Array<() => void> = [];
  if (opts.microSignals) {
    // tab_loss is a single document-level `visibilitychange` signal, so enabling
    // it on every section detector would emit one tab_loss per section
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
    clearInterval(heartbeat);
    doc.removeEventListener('visibilitychange', onVisibility);
    win?.removeEventListener('pagehide', onPageHide);
    win?.removeEventListener('pageshow', onPageShow);
    for (const c of detectorCleanups) c();
    try { observer.disconnect(); } catch { /* ignore */ }
  };
}
