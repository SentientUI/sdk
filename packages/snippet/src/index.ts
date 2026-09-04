import { init, grantConsent as coreGrantConsent, isDoNotTrackEnabled, readSnapshot, writeSnapshot, type CompoundLocator, type DecideOutcome, type GoalDefinition, type SentientClient, type SlotConfigEntry } from '@sentientui/core';
import { startEngagementCapture, type SemanticType } from '@sentientui/core/engagement';
import { parseSnippetConfig, type SnippetConfig } from './config';
import { applyPersonaAttributes, applySlotAttributes, applySlotArms, applyRegistrySlots } from './apply';
import { setBlockPalette, sweepOrphanBlocks } from './blocks';
import { attachSlotSignals, type AppliedSlot } from './slot-signals';
import { installGoalListeners, clearFiredGoals, type GoalListeners } from './goal-wiring';
import { resolveLocatorOne } from './locator';
import { cacheEditorToken, readCachedEditorToken } from './editor-token';

export { parseSnippetConfig } from './config';
export { applyPersonaAttributes, applySlotAttributes, applySlotArms, applyRegistrySlots } from './apply';

// Injected at build time from package.json (see tsup.config.ts `define`), so the
// version shipped inside the browser bundle always matches the released version
// and can never drift. Falls back to a dev sentinel when built without the define
// (e.g. unit tests run through vitest, which don't apply tsup's define).
declare const __SNIPPET_VERSION__: string;
export const version: string =
  typeof __SNIPPET_VERSION__ !== 'undefined' ? __SNIPPET_VERSION__ : '0.0.0-dev';

const DECIDE_TIMEOUT_MS = 5000;
const REAPPLY_DEBOUNCE_MS = 50;

// Pre-boot goal queue: a merchant stub
//   window.SentientSnippet = window.SentientSnippet || { q: [], goal: function () { this.q.push(['goal'].concat([].slice.call(arguments))); } };
// can record conversions before this bundle loads. Captured at module-eval
// time — tsup's IIFE assignment replaces the global right AFTER the module
// body runs, so this is the last moment the stub is visible.
type PrebootCall = ['goal', string, Record<string, unknown>?];
const prebootQueue: PrebootCall[] = (() => {
  try {
    if (typeof window === 'undefined') return [];
    const pre = (window as unknown as { SentientSnippet?: { q?: unknown } }).SentientSnippet;
    return Array.isArray(pre?.q) ? (pre!.q as PrebootCall[]) : [];
  } catch {
    return [];
  }
})();

type Band = 'low' | 'medium' | 'high';
type SlotResults = Record<string, string | Record<string, string>>;

// --- Saved decision state --------------------------------------------------
// reapply() and SPA navigation re-stamp attributes from THIS state — never a new
// decide (the decision is locked for the visit).
let activeCfg: SnippetConfig | null = null;
let activeClient: SentientClient | null = null;
let activeSlots: SlotResults = {};
let activeSlotConfig: Record<string, SlotConfigEntry> | null = null;
let goalListeners: GoalListeners | null = null;
// The editor-defined goals served with this visit's decision. Kept so a
// revoke→grant cycle can re-install the listeners it tore down — the decision
// is locked for the visit, so re-wiring from this state is correct and a new
// decide is not.
let activeGoals: GoalDefinition[] | null = null;
let slotSignalsCleanup: (() => void) | null = null;
let sectionCaptureCleanup: (() => void) | null = null;
let activePersona: { persona: string; band: Band } | null = null;
// Served section order for this visit (config `sections`, B1.1). Seeded from
// the snapshot pre-paint, overwritten by the authoritative decide; reapply()
// re-applies it (bounded) after hydration wipes / SPA re-renders.
let activeLayoutOrder: string[] | null = null;
let spaHooksInstalled = false;
let reapplyTimer: ReturnType<typeof setTimeout> | null = null;
// Served, route-scoped section map (persona-coverage classification). Kept at
// module scope so an SPA navigation can re-derive the typeOf hook for the new
// path when section capture restarts.
let activeSectionMap: Array<{ urlMatch: string; locator: unknown; type: string }> | null = null;
// The pathname section capture was last (re)started against — a real change
// triggers a restart in reapply() so new-route sections are measured.
let lastCapturePath: string | null = null;
// True only AFTER the authoritative post-decide apply. Until then reapply() must
// NOT paint copy/ops from the (possibly stale) snapshot — an SPA navigation
// during the decide window would otherwise flash the previous visit's content,
// and a decide timeout would leave it stuck (audit M: stale-content reapply).
let decided = false;
// Live consent granted AFTER load via SentientSnippet.grantConsent(). A site that
// boots with consent:false never starts section/slot-signal capture in run(); this
// flag lets the capture gate re-open the moment consent arrives, without a reload
// (audit: grantConsent never started capture for consent-after-load visitors).
let consentGranted = false;
// True only between revokeConsent() and the next grantConsent()/run(). It is
// what distinguishes "client destroyed by revocation, grant should re-init"
// from "client never existed" (editor/preview modes expose the API with no
// client, and grant must NOT mint a tracking client there).
let consentRevoked = false;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  // Clear the timer once the race settles either way: a fast decide otherwise
  // left the 5s timeout callback (and its closure) pinned alive on every page
  // view (audit SNIP-14).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([p, timeout]).then(
    (v) => { clearTimeout(timer); return v; },
    (e) => { clearTimeout(timer); throw e; },
  );
}

function dbg(cfg: SnippetConfig | null, ...args: unknown[]): void {
  if (cfg?.debug) console.log('[sentient-snippet]', ...args);
}

function applyAll(
  doc: Document,
  opts?: { contentAndOps?: boolean; onApplied?: (slotId: string, arm: string, el: Element) => void },
): string[] {
  if (!activeCfg) return [];
  if (activeCfg.personaAttributes && activePersona) {
    applyPersonaAttributes(activePersona.persona, activePersona.band, doc);
  }
  applySlotAttributes(activeSlots, activeCfg.slots, doc);
  applySlotArms(activeSlots, activeCfg.slots, doc);
  // Registry-mode slots carry their own target/content (no page-declared decl).
  // Returns the slot ids whose locator found nothing (a health signal).
  if (activeSlotConfig) return applyRegistrySlots(activeSlots, activeSlotConfig, doc, opts);
  // No registry config at all: the project reverted to code-declared slots, or
  // decide answered without one. A pre-paint pass may still have applied blocks
  // from the snapshot and hidden the merchant's own content, and nothing else
  // would ever put it back — applyRegistrySlots owns the only restore path.
  sweepOrphanBlocks(doc, new Set());
  return [];
}

/** Resolve the configured section selectors against the current document.
 *  A selector matching zero elements is dropped (that page variant simply
 *  doesn't have it — not an error); one matching MORE than one is dropped too,
 *  because reordering an ambiguous match could move the wrong element (the
 *  registry-locator "no guess" rule). Keyed by selector string = the wire id. */
function resolveSections(doc: Document): Map<string, Element> {
  const out = new Map<string, Element>();
  for (const sel of activeCfg?.sections ?? []) {
    try {
      const els = doc.querySelectorAll(sel);
      if (els.length === 1) out.set(sel, els[0]!);
    } catch {
      /* invalid selector — dropped */
    }
  }
  return out;
}

/** Bounded section reorder (B1.1): apply a served order only when (a) every id
 *  resolves right now, (b) all resolved elements share one parent, and (c) the
 *  order is exactly a permutation of the currently-resolvable section set. Any
 *  mismatch applies nothing, silently — the registry-move rule (a drifted
 *  anchor applies nothing) extended to whole-page order, so a stale snapshot or
 *  an edited `sections` config can never wedge a half-reordered page. */
function applyLayoutOrder(order: string[] | null | undefined, doc: Document): void {
  try {
    if (!order || order.length < 2) return;
    if (new Set(order).size !== order.length) return;
    const resolved = resolveSections(doc);
    if (resolved.size !== order.length) return;
    const els: Element[] = [];
    for (const id of order) {
      const el = resolved.get(id);
      if (!el) return;
      els.push(el);
    }
    const parent = els[0]!.parentNode;
    if (!parent || !els.every((el) => el.parentNode === parent)) return;
    // Successive insertBefore within the shared parent — the registry move-op
    // primitive. domOrder tracks the sections' current relative order; step i
    // places the wanted element into the i-th section position, so already-
    // ordered prefixes are never touched (idempotent on reapply).
    const domOrder = els
      .slice()
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    for (let i = 0; i < els.length; i++) {
      const want = els[i]!;
      if (domOrder[i] === want) continue;
      parent.insertBefore(want, domOrder[i]!);
      domOrder.splice(domOrder.indexOf(want), 1);
      domOrder.splice(i, 0, want);
    }
  } catch {
    /* fail-safe */
  }
}

/** Best-effort beacon of locator misses so the worker can suspend broken slots. */
function reportLocatorMisses(cfg: SnippetConfig, slots: string[]): void {
  if (slots.length === 0) return;
  try {
    const base = cfg.apiBase ?? 'https://api.sentient-ui.com';
    void fetch(`${base}/v1/locator-miss`, {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ slots }),
    }).catch(() => undefined);
  } catch {
    /* fail-safe */
  }
}

/** Whether section engagement capture is permitted for the current visit — the
 *  same privacy/consent gate run() applies before the first start. */
function sectionCaptureAllowed(): boolean {
  return !!(
    activeCfg &&
    activeClient &&
    activeCfg.sectionCapture !== false &&
    // Configured-consent OR consent granted live after load (grantConsent()).
    (activeCfg.consent !== false || consentGranted) &&
    !isDoNotTrackEnabled()
  );
}

/** Start section + per-option slot-signal capture against the current document
 *  when consent has just been granted after load. No-op if a client isn't ready,
 *  the privacy gate still forbids it, or capture is already running. */
function startCaptureAfterConsent(): void {
  if (!activeClient || !activeCfg || !sectionCaptureAllowed()) return;
  if (sectionCaptureCleanup) return; // already running — never double-start
  // Re-collect the applied (slot, arm, element) triples so per-option detectors
  // bind to the live elements (idempotent restamp; content only once decided).
  const appliedSlots: AppliedSlot[] = [];
  applyAll(document, {
    contentAndOps: decided,
    onApplied: (slotId, arm, el) => appliedSlots.push({ slotId, arm, el }),
  });
  startSectionCapture();
  try {
    slotSignalsCleanup?.();
    slotSignalsCleanup = attachSlotSignals(activeClient, activeCfg.apiKey, appliedSlots);
  } catch { /* fail-safe */ }
}

/** (Re)start section engagement capture against the CURRENT document/route.
 *  Re-derives the served typeOf hook for the current pathname (the section map is
 *  route-scoped) and records the path so reapply() can detect a real navigation.
 *  A fresh startEngagementCapture recomputes its own pageUrl. */
function startSectionCapture(): void {
  if (typeof document === 'undefined' || !sectionCaptureAllowed()) return;
  let typeOf: ((el: Element) => SemanticType | null) | undefined;
  try {
    if (activeSectionMap && activeSectionMap.length > 0) {
      const resolved = new Map<Element, SemanticType>();
      for (const entry of activeSectionMap) {
        if (entry.urlMatch !== window.location.pathname) continue;
        const el = resolveLocatorOne(entry.locator as CompoundLocator, document);
        if (el) resolved.set(el, entry.type as SemanticType);
      }
      if (resolved.size > 0) typeOf = (el) => resolved.get(el) ?? null;
    }
  } catch { /* fail-safe — capture falls back to local heuristics */ }
  try {
    sectionCaptureCleanup = startEngagementCapture(activeClient!, {
      apiKey: activeCfg!.apiKey, apiBase: activeCfg!.apiBase, doc: document, microSignals: true,
      ...(typeOf ? { typeOf } : {}),
    });
    lastCapturePath = window.location.pathname;
  } catch { /* fail-safe */ }
}

/** Re-stamp attributes from the already-decided session state. Never re-decides;
 *  the escape hatch for hydration wipes and client-side navigation. */
export function reapply(): void {
  try {
    // Collect the (re-)applied elements so per-option detectors can move to them.
    // SPA navigation / hydration replaces the DOM under the original detectors,
    // which would otherwise stop emitting for the rest of the visit while
    // section-level capture keeps running — undercounting per-option signals
    // versus the section row (audit M3).
    const appliedSlots: AppliedSlot[] = [];
    // Always detach the prior page's per-option detectors FIRST — independent of
    // how many slots the new page applies. Navigating to a route with no applied
    // slots would otherwise skip cleanup, leaving hover/micro-signal detectors
    // bound to now-detached nodes for the rest of the visit (audit).
    slotSignalsCleanup?.();
    slotSignalsCleanup = null;
    // Pre-decide reapplies restamp reversible attributes only — never copy/ops
    // from a possibly-stale snapshot (`decided` is false until the authoritative
    // post-decide apply). Once decided, content is safe to restamp.
    applyAll(document, {
      contentAndOps: decided,
      onApplied: (slotId, arm, el) => appliedSlots.push({ slotId, arm, el }),
    });
    // Restore the served section order after a hydration wipe / SPA re-render.
    // Bounded, so a route without the configured sections applies nothing; the
    // pre-decide value is the snapshot's, the same trust level as pre-paint.
    applyLayoutOrder(activeLayoutOrder, document);
    if (appliedSlots.length > 0 && sectionCaptureAllowed()) {
      try {
        slotSignalsCleanup = attachSlotSignals(activeClient!, activeCfg!.apiKey, appliedSlots);
      } catch { /* fail-safe */ }
    }
    // Section capture is route-scoped. When an SPA navigation actually changed the
    // path, tear down the old-page capture and restart it against the new document
    // so the new route's sections are discovered/registered/measured — otherwise
    // persona/section signals only ever cover the first page (audit).
    try {
      if (
        typeof window !== 'undefined' &&
        lastCapturePath !== null &&
        window.location.pathname !== lastCapturePath &&
        sectionCaptureAllowed()
      ) {
        sectionCaptureCleanup?.();
        sectionCaptureCleanup = null;
        startSectionCapture();
      }
    } catch { /* fail-safe */ }
  } catch {
    /* fail-safe */
  }
}

function scheduleReapply(): void {
  if (reapplyTimer !== null) return;
  reapplyTimer = setTimeout(() => {
    reapplyTimer = null;
    reapply();
    // Catch url_reached goals on pushState/replaceState navigations (popstate is
    // handled directly by the goal listeners).
    try { goalListeners?.checkUrl(); } catch { /* fail-safe */ }
  }, REAPPLY_DEBOUNCE_MS);
}

// Re-apply after SPA navigation (Framer/Next client routing) without a
// MutationObserver: hook history + popstate, debounced. Installed once.
function installSpaHooks(): void {
  if (spaHooksInstalled || typeof window === 'undefined' || typeof history === 'undefined') return;
  spaHooksInstalled = true;
  try {
    const patch = (name: 'pushState' | 'replaceState') => {
      const orig = history[name];
      history[name] = function (this: History, data: unknown, unused: string, url?: string | URL | null) {
        const ret = orig.call(this, data, unused, url ?? null);
        scheduleReapply();
        return ret;
      };
    };
    patch('pushState');
    patch('replaceState');
    window.addEventListener('popstate', scheduleReapply);
  } catch {
    /* fail-safe */
  }
}

function matchCounts(cfg: SnippetConfig): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, decl] of Object.entries(cfg.slots)) {
    // Per-slot guard, same rule as resolveSections: one invalid declared
    // selector counts 0 for THAT slot instead of throwing out of the loop —
    // and out of page-exposed getState() into host code (audit SNIP-4).
    try {
      out[id] = decl.target ? document.querySelectorAll(decl.target).length : 1;
    } catch {
      out[id] = 0;
    }
  }
  return out;
}

export type SnippetState = {
  apiKey: string;
  persona: string | null;
  band: Band | null;
  slots: SlotResults;
  matchCounts: Record<string, number>;
  consent: boolean;
};

// ?sentient_preview=hero:tone=urgent,motion=pulse|checkout:express
// Apply-only QA: force the given dims/arm for this page view. No decide, no
// events, no snapshot write. Modeled on core's ?sentient_persona= override.
/** Read the on-site editor token from the URL (?sentient_editor=<token>). */
export function parseEditorToken(search: string): string | null {
  return new URLSearchParams(search).get('sentient_editor');
}

// Editor asset URL: explicit config wins; otherwise derive from the snippet's
// own <script src> by swapping the filename to editor.global.js.
function deriveEditorSrc(): string | null {
  try {
    const scripts = Array.from(document.getElementsByTagName('script'));
    // Anchored to a path segment and the end of the filename: a bare substring
    // match hijacked any site script whose name merely CONTAINED the token
    // (e.g. /js/carousel-snippet.js), deriving a bogus editor URL (audit SNIP-16).
    const re = /(^|\/)snippet(\.global)?\.js(\?|$)/;
    const self = scripts.find((s) => re.test(s.src));
    if (self?.src) return self.src.replace(re, '$1editor.global.js$3');
  } catch {
    /* fail-safe */
  }
  return null;
}

/** Load the separate editor overlay bundle (zero bytes on the normal path).
 *  Hands it the token + API base via a global, then injects the script tag. */
function loadEditor(cfg: SnippetConfig, token: string): void {
  try {
    (window as unknown as { __sentientEditor?: unknown }).__sentientEditor = {
      token,
      apiBase: cfg.apiBase ?? 'https://api.sentient-ui.com',
    };
    // Restrictive referrer policy while the editor is active (defense in depth
    // for the token, Phase 3 §1.4).
    try {
      const meta = document.createElement('meta');
      meta.name = 'referrer';
      meta.content = 'no-referrer';
      // Marked so the editor's teardown can remove exactly this meta (and not a
      // site's own referrer policy) when the user closes the editor.
      meta.setAttribute('data-sentient-editor', '');
      (document.head ?? document.documentElement).appendChild(meta);
    } catch {
      /* fail-safe */
    }
    const src = cfg.editorSrc ?? deriveEditorSrc();
    if (!src) {
      // No resolvable editor bundle URL — surface it instead of leaving a blank
      // page (the editor's own toast can't fire because its code never loads).
      showEditorLoadNotice();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    // A cold CDN edge / 404 / blocked request would otherwise fail silently and
    // strand the user on an unchanged page — tell them how to recover.
    s.onerror = () => showEditorLoadNotice();
    (document.head ?? document.documentElement).appendChild(s);
  } catch {
    /* fail-safe */
  }
}

const EDITOR_LOAD_NOTICE_ID = 'sentient-editor-load-notice';

// Chrome shared by both snippet-side pinned overlays (editor-load notice and
// persona-preview banner): one literal in the always-on bundle instead of two
// duplicated ones (audit SNIP-17 — recovered bytes fund this batch's fixes).
const PINNED_BOX_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'fixed', bottom: '16px', zIndex: '2147483647',
  background: '#111827', color: '#fff',
  boxShadow: '0 10px 34px rgba(0,0,0,0.45)',
};

/** Minimal fallback notice shown from the SNIPPET side when the separate editor
 *  bundle can't even load (cold CDN, 404, blocked, or no derivable src). The
 *  editor's richer toast is unavailable in that case because its code never ran,
 *  so without this the user is left on a blank page with no clue why. Copy mirrors
 *  the editor's load-error toast: reopening from the dashboard is the recovery. */
function showEditorLoadNotice(): void {
  try {
    if (typeof document === 'undefined' || document.getElementById(EDITOR_LOAD_NOTICE_ID)) return;
    // Every caller of this notice is an editor-load FAILURE: the no-referrer
    // meta loadEditor injected for the (never-started) editor session must not
    // outlive it, or the site's own referrer policy stays degraded for the
    // rest of the page view (audit SNIP-7). The marker attribute scopes the
    // removal to exactly our meta, never a site-owned one.
    document.querySelector('meta[name="referrer"][data-sentient-editor]')?.remove();
    const box = document.createElement('div');
    box.id = EDITOR_LOAD_NOTICE_ID;
    box.textContent = 'Couldn’t load the editor — check your connection and reopen it from your dashboard.';
    Object.assign(box.style, PINNED_BOX_STYLE, {
      right: '16px', maxWidth: '320px', padding: '14px 16px', borderRadius: '14px',
      font: '13px/1.45 system-ui, sans-serif',
      border: '1px solid rgba(245,158,11,0.6)', cursor: 'pointer',
    } as Partial<CSSStyleDeclaration>);
    box.addEventListener('click', () => box.remove());
    (document.body ?? document.documentElement).appendChild(box);
    setTimeout(() => box.remove(), 10000);
  } catch {
    /* fail-safe */
  }
}

export function parsePreview(search: string): SlotResults | null {
  const raw = new URLSearchParams(search).get('sentient_preview');
  if (!raw) return null;
  const out: SlotResults = {};
  for (const part of raw.split('|')) {
    // Split on the FIRST colon only, so a spec value may itself contain colons
    // (e.g. hero:label=a:b) without being truncated.
    const colon = part.indexOf(':');
    const slotId = colon === -1 ? '' : part.slice(0, colon);
    const spec = colon === -1 ? '' : part.slice(colon + 1);
    if (!slotId || !spec) continue;
    if (spec.includes('=')) {
      const dims: Record<string, string> = {};
      for (const kv of spec.split(',')) {
        const [k, v] = kv.split('=');
        if (k && v) dims[k] = v;
      }
      if (Object.keys(dims).length) out[slotId] = dims;
    } else {
      out[slotId] = spec;
    }
  }
  return Object.keys(out).length ? out : null;
}

// ?sentient_persona=<key> — the dashboard "Preview as this audience" CTA opens
// the live site with this param. Read-only preview intent (see previewPersona).
export function parsePersonaPreview(search: string): string | null {
  try {
    return new URLSearchParams(search).get('sentient_persona') || null;
  } catch {
    return null;
  }
}

const PREVIEW_BANNER_ID = 'sentient-persona-preview-banner';

/** Fixed "Previewing as X · Exit preview" affordance so an operator always knows
 *  the page is simulated, and can leave (strips the param + reloads). With
 *  `unrecognized`, says so instead — the typed value isn't in the project's
 *  persona vocabulary, so the page is showing the default experience, and the
 *  banner must not claim otherwise (B1.2). */
function showPreviewBanner(persona: string, unrecognized?: boolean): void {
  try {
    if (typeof document === 'undefined' || document.getElementById(PREVIEW_BANNER_ID)) return;
    const label = persona.charAt(0).toUpperCase() + persona.slice(1).replace(/[_-]+/g, ' ');
    const box = document.createElement('div');
    box.id = PREVIEW_BANNER_ID;
    box.setAttribute('role', 'status');
    Object.assign(box.style, PINNED_BOX_STYLE, {
      left: '50%', transform: 'translateX(-50%)',
      display: 'flex', alignItems: 'center', gap: '12px',
      padding: '10px 14px', borderRadius: '999px',
      font: '13px/1 system-ui, sans-serif',
      border: '1px solid rgba(255,255,255,0.14)',
    } as Partial<CSSStyleDeclaration>);
    const text = document.createElement('span');
    text.textContent = unrecognized
      ? `“${persona}” isn’t in your personas — showing the default experience`
      : `Previewing as ${label}`;
    const exit = document.createElement('button');
    exit.type = 'button';
    exit.textContent = 'Exit preview';
    Object.assign(exit.style, {
      cursor: 'pointer', border: '1px solid rgba(255,255,255,0.3)', background: 'transparent',
      color: '#fff', font: 'inherit', padding: '4px 10px', borderRadius: '999px',
    } as Partial<CSSStyleDeclaration>);
    exit.addEventListener('click', () => {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('sentient_persona');
        window.location.href = url.pathname + url.search + url.hash;
      } catch {
        /* fail-safe */
      }
    });
    box.appendChild(text);
    box.appendChild(exit);
    (document.body ?? document.documentElement).appendChild(box);
  } catch {
    /* fail-safe */
  }
}

/**
 * Event-free persona preview: simulate what one audience is served via
 * /v1/explain (read-only — no impression, decision, or slot_decisions write),
 * apply it, and stop. No `init`, no tracking, no snapshot. Registry-mode sites
 * ask the server for their published slots; declared-slot sites send their own.
 */
async function previewPersona(cfg: SnippetConfig, persona: string): Promise<void> {
  const base = cfg.apiBase ?? 'https://api.sentient-ui.com';
  const registryMode = cfg.registry ?? Object.keys(cfg.slots).length === 0;
  const reqBody = registryMode
    ? { persona, slotsFrom: 'registry' as const }
    : { persona, slots: Object.entries(cfg.slots).map(([id, s]) => ({ id, dims: s.dims })) };

  const outcome = await withTimeout(
    fetch(`${base}/v1/explain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(reqBody),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    DECIDE_TIMEOUT_MS,
  );
  if (!outcome) {
    // The page API must exist on the failure path too (same reason as editor/
    // preview modes in run(): page code calling SentientSnippet.goal() must
    // not throw), and with no activeClient it is a no-op surface.
    exposeGlobal(cfg);
    dbg(cfg, 'persona preview: explain unavailable — page left as-is');
    return;
  }

  const data = outcome as {
    slots?: SlotResults;
    slotConfig?: Record<string, SlotConfigEntry>;
    persona?: string;
    personaDisplay?: string;
    recognized?: boolean;
    personaAttributes?: { persona?: string; confidence?: string };
  };
  activeSlots = data.slots ?? {};
  activeSlotConfig = data.slotConfig ?? null;
  // Palette parity with live serving: block arms in a preview render in the
  // site's colors too (the explain response mirrors decide's palette field).
  setBlockPalette((data as { palette?: import('@sentientui/core').SitePalette }).palette);
  const shown = data.personaAttributes?.persona ?? data.persona ?? persona;
  const band = (data.personaAttributes?.confidence as Band) ?? 'high';
  activePersona = { persona: shown, band };
  // Apply, but never beacon locator misses here — that feed can suspend slots,
  // and a read-only preview must have zero side effects.
  applyAll(document);
  // Preview content is authoritative for this view, so a later reapply() may
  // restamp copy/ops (not just reversible attributes).
  decided = true;
  // Same as slot preview mode: on hydrating/client-routed sites the preview is
  // wiped after first paint, and without these hooks it was never restamped —
  // the operator just saw the default page (audit SNIP-9).
  installSpaHooks();
  exposeGlobal(cfg);
  // Vocabulary echo (B1.2): only an explicit `recognized: false` shows the
  // "not one of your personas" banner — an older API omits the field, and the
  // legacy claim beats wrongly contradicting a valid key. Recognized previews
  // prefer the server's display name over the cosmetic capitalization, and the
  // unrecognized banner quotes what was TYPED, not the folded 'unknown'.
  if (data.recognized === false) showPreviewBanner(persona, true);
  else showPreviewBanner(data.personaDisplay ?? shown);
}

function exposeGlobal(cfg: SnippetConfig): void {
  const api = {
    /** Record a conversion. The second argument is either legacy metadata or a
     *  GoalOptions object ({ value, currency, externalId, metadata }) — core
     *  disambiguates; revenue fields flow through verbatim (spec §5). */
    goal(name: string, opts?: Record<string, unknown>): void {
      try {
        activeClient?.goal(name, opts);
      } catch {
        /* fail-safe */
      }
    },
    componentGoal(slotId: string, goalType: string): void {
      try {
        activeClient?.componentGoal(slotId, goalType);
      } catch {
        /* fail-safe */
      }
    },
    grantConsent(): void {
      // Kept in its own try so an init/flush error never blocks starting
      // capture below.
      try {
        if (!activeClient && consentRevoked) {
          // A prior revokeConsent() destroyed the client — core deleted its
          // registry entry, so coreGrantConsent() would warn "called before
          // init()" and every later goal()/track() would silently hit a dead
          // client until a full reload. Resuming means a FRESH init with
          // consent granted: revoke deliberately forgot the visitor (destroy
          // cleared the identity cookie/storage), so this mints a new identity
          // rather than resurrecting the severed one — that forgetting is the
          // point of revocation, not a bug to undo. init() itself still honors
          // DNT/GPC, so a global opt-out cannot be overridden here.
          activeClient = init({
            apiKey: cfg.apiKey,
            context: cfg.context,
            consent: true,
            preConsentBehavior: cfg.preConsentBehavior,
            debug: cfg.debug,
            persona: cfg.persona,
          });
          // Re-install the editor-defined goal listeners revoke tore down —
          // from the visit's served decision, never a new decide.
          if (activeGoals && activeGoals.length > 0) {
            goalListeners?.teardown();
            goalListeners = installGoalListeners(activeGoals, activeClient, document, cfg.apiKey);
          }
        } else {
          // Normal path: the client is a live pre-consent proxy — upgrade it in
          // place and flush core's queued events.
          coreGrantConsent(cfg.apiKey);
          // Install the editor-defined goal listeners run() withheld for a
          // consent:false boot — without this, a visit that granted consent
          // after load recorded ZERO click/submit/url/scroll goals (audit
          // SNIP-1: the missing half of the capture-after-consent fix; the
          // revoke→grant branch above already re-wires them from the same
          // module-scope activeGoals, never a new decide).
          if (activeClient && activeGoals && activeGoals.length > 0) {
            goalListeners?.teardown();
            goalListeners = installGoalListeners(activeGoals, activeClient, document, cfg.apiKey);
          }
        }
        consentRevoked = false;
      } catch {
        /* fail-safe */
      }
      // Re-open the capture gate and start section/slot-signal capture now, so a
      // site that booted with consent:false lights up persona/section + per-option
      // signals on consent instead of only after a full page reload (audit).
      consentGranted = true;
      try {
        startCaptureAfterConsent();
      } catch {
        /* fail-safe */
      }
    },
    revokeConsent(): void {
      try {
        // Detach capture observers/listeners before destroying the client so a
        // revoke leaves no IntersectionObserver / visibilitychange / pagehide
        // listeners running (they'd otherwise leak until page unload).
        sectionCaptureCleanup?.();
        sectionCaptureCleanup = null;
        lastCapturePath = null;
        slotSignalsCleanup?.();
        slotSignalsCleanup = null;
        // Tear down the editor-defined goal listeners too — otherwise the
        // delegated click/submit/popstate handlers keep calling goal() on the
        // client we're about to destroy (leak on a destroyed client, audit).
        goalListeners?.teardown();
        goalListeners = null;
        // Forget the fired-goal latches too: forget-me must be total, and the
        // `_snt_fired_goals_*` sessionStorage entry otherwise kept naming the
        // visitor's conversions after revoke (audit SNIP-12, privacy).
        clearFiredGoals(typeof window !== 'undefined' ? window : null, cfg.apiKey);
        consentGranted = false;
        consentRevoked = true;
        activeClient?.destroy();
        // Null the reference: the destroyed client is not just inert, it is
        // gone from core's registry, so keeping it wired left grantConsent()
        // warning "called before init()" and capture recording into a dead
        // client — revoke→grant permanently killed tracking until reload.
        // grantConsent() above treats null as "re-init fresh".
        activeClient = null;
      } catch {
        /* fail-safe */
      }
    },
    reapply,
    getState(): SnippetState {
      // Wrapped like goal/grantConsent: this is page-exposed, so a throw here
      // lands in merchant host code (audit SNIP-4).
      try {
        return {
          apiKey: cfg.apiKey,
          persona: activePersona?.persona ?? null,
          band: activePersona?.band ?? null,
          slots: activeSlots,
          matchCounts: matchCounts(cfg),
          // Live flags, not boot-time config: a visitor who granted after load
          // (or revoked) otherwise read the wrong consent state for the rest
          // of the visit (audit SNIP-8).
          consent: !consentRevoked && (cfg.consent !== false || consentGranted),
        };
      } catch {
        return { apiKey: cfg.apiKey, persona: null, band: null, slots: {}, matchCounts: {}, consent: false };
      }
    },
  };
  // Intentional shape-shift: at build time tsup assigns the module's exported
  // surface (parseSnippetConfig, applyPersonaAttributes, version, run, …) to the
  // `SentientSnippet` IIFE global. At runtime we deliberately REPLACE it with the
  // live instance api (goal/componentGoal/consent/reapply/getState) — that
  // runtime control surface is what snippet consumers call on the page, so it
  // must win. The build-time exports are only used by bundlers importing the
  // package, never at runtime, so overwriting the global here is safe.
  (window as unknown as { SentientSnippet?: unknown }).SentientSnippet = api;
  // Replay conversions recorded on a pre-boot stub (captured at module eval).
  for (const call of prebootQueue.splice(0)) {
    try {
      if (call[0] === 'goal') api.goal(call[1], call[2]);
    } catch {
      /* fail-safe */
    }
  }
}

// Minimal callable page API for the paths where run() can't build the real one
// (malformed/missing config, or the outer catch before exposeGlobal ran). The
// build-time IIFE global has no goal method, so leaving it installed made
// merchant SentientSnippet.goal() THROW and stranded the pre-boot stub queue —
// the same bug already fixed for editor/preview modes (audit SNIP-6). Never
// downgrades: a live api (goal is a function) is left untouched.
function exposeNoopGlobal(): void {
  try {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { SentientSnippet?: { goal?: unknown } & Record<string, unknown> };
    if (typeof w.SentientSnippet?.goal === 'function') return;
    const noop = (): void => {};
    w.SentientSnippet = {
      goal: noop,
      componentGoal: noop,
      grantConsent: noop,
      revokeConsent: noop,
      reapply: noop,
      getState: (): SnippetState =>
        ({ apiKey: '', persona: null, band: null, slots: {}, matchCounts: {}, consent: false }),
    };
    // Drain the pre-boot stub queue so a later boot never replays stale calls.
    prebootQueue.length = 0;
  } catch {
    /* fail-safe */
  }
}

/**
 * Style + Safe-Swap rung for non-React sites. Order of operations:
 *  1. preview short-circuit (apply-only, no tracking),
 *  2. pre-paint apply from the core decision snapshot (return visits),
 *  3. session + decide via @sentientui/core,
 *  4. set persona attrs (opt-in), per-slot data-<dim> attributes, and
 *     data-sentient-arm for enumerated arms,
 *  5. write the snapshot for the next visit,
 *  6. expose window.SentientSnippet (goal wiring, consent, reapply, getState).
 * Any error or timeout leaves the DOM exactly as it was (fail-safe). Never
 * accepts HTML and never observes mutations; the structural changes are:
 * a registry move op relocating an element among its own siblings (post-decide
 * pass only — pre-paint stays attributes-only, see apply.ts), the bounded
 * section reorder for config `sections` (applyLayoutOrder — the cached order
 * IS applied pre-paint, because a reorder is exactly what must not flash, and
 * its bounds re-verify against the current DOM), and Composition Block arms
 * (blocks.ts — a typed enumerated tree rendered via createElement, every arm
 * pre-rendered hidden and revealed by arm id, both passes).
 */
export async function run(): Promise<void> {
  try {
    const cfg = parseSnippetConfig((window as unknown as { sentient?: unknown }).sentient);
    if (!cfg) {
      // A bad pk_/malformed config must still leave a callable API behind
      // (audit SNIP-6).
      exposeNoopGlobal();
      return;
    }
    activeCfg = cfg;
    // Fresh visit decision: withhold content restamping from reapply() until this
    // run's /v1/decide confirms it (see the `decided` declaration).
    decided = false;
    activeLayoutOrder = null;
    setBlockPalette(null);
    // Reset live-consent for this visit; only a later grantConsent() re-opens it.
    consentGranted = false;
    consentRevoked = false;
    activeGoals = null;

    // Editor mode (?sentient_editor=<token>) — load the on-site editor overlay
    // and stop. No decide, events, snapshot, or slot apply (the editor suppresses
    // all tracking exactly like preview mode).
    const urlEditorToken = typeof window !== 'undefined' ? parseEditorToken(window.location.search) : null;
    if (urlEditorToken) {
      // Cache the token in sessionStorage FIRST so a reload — or navigating to
      // another page of the same site in this tab — re-enters editor mode without
      // reopening the dashboard, THEN strip the token from the visible URL
      // immediately (Phase 3 §1.4) so this bearer secret can't leak via history,
      // referrer, bookmarks, or logs. sessionStorage is tab-scoped and never
      // travels in a URL/referrer, so it's a strictly safer carrier than the URL.
      cacheEditorToken(urlEditorToken);
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('sentient_editor');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      } catch {
        /* fail-safe */
      }
    }
    // Fall back to the cached token on a reload where the URL no longer carries it.
    const editorToken = urlEditorToken ?? readCachedEditorToken();
    if (editorToken) {
      loadEditor(cfg, editorToken);
      // Expose the page API even though tracking is suppressed: merchant code
      // calling SentientSnippet.goal(...) otherwise THROWS in this mode (the
      // build-time global has no goal method), and the pre-boot stub queue is
      // stranded. With no activeClient every method is a harmless no-op —
      // exactly the tracking suppression editor mode promises — and the queue
      // drains into those no-ops instead of replaying on a later real visit.
      exposeGlobal(cfg);
      dbg(cfg, 'editor mode');
      return;
    }

    // Preview mode — apply forced state and stop. No init, no tracking.
    const preview = typeof window !== 'undefined' ? parsePreview(window.location.search) : null;
    if (preview) {
      activeSlots = preview;
      activePersona = null;
      applyAll(document);
      installSpaHooks();
      // Same as editor mode above: the API must exist (no-op without a client)
      // so page code calling SentientSnippet.goal(...) doesn't throw.
      exposeGlobal(cfg);
      dbg(cfg, 'preview mode', preview);
      return;
    }

    // Persona preview (?sentient_persona=<key>) — simulate what one audience is
    // served, event-free via /v1/explain, then stop. No init, no tracking, no
    // snapshot. The dashboard "Preview as this audience" CTA opens the live site
    // with this param; it never fires on ordinary visits.
    const personaPreview = typeof window !== 'undefined' ? parsePersonaPreview(window.location.search) : null;
    if (personaPreview) {
      await previewPersona(cfg, personaPreview);
      dbg(cfg, 'persona preview', personaPreview);
      return;
    }

    // Registry mode: bare `{ apiKey }` (no declared slots) opts in by default;
    // an explicit `registry` flag overrides either way.
    const registryMode = cfg.registry ?? Object.keys(cfg.slots).length === 0;

    const snap = readSnapshot(cfg.apiKey);
    if (snap) {
      activePersona = { persona: snap.persona, band: snap.band };
      activeSlots = snap.slots;
      if (snap.slotConfig) activeSlotConfig = snap.slotConfig;
      // Palette BEFORE the pre-paint apply: cached block arms must render in
      // the site's colors from the first paint, not flip from neutral.
      if (snap.palette) setBlockPalette(snap.palette);
      // Pre-paint applies only reversible attributes (persona/arm/dims) from the
      // cached snapshot. Copy/ops are withheld until /v1/decide confirms them —
      // a stale snapshot must never flash wrong content that a decide timeout
      // would leave stuck on screen.
      applyAll(document, { contentAndOps: false });
      // The cached section order, by contrast, IS applied pre-paint: a late
      // reorder is exactly the flash to avoid, and the bounded apply re-verifies
      // against the CURRENT DOM (a stale/foreign order applies nothing). The
      // post-decide apply below then corrects any drift authoritatively.
      if (snap.layoutOrder) {
        activeLayoutOrder = snap.layoutOrder;
        applyLayoutOrder(activeLayoutOrder, document);
      }
    }

    const client = init({
      apiKey: cfg.apiKey,
      context: cfg.context,
      consent: cfg.consent,
      preConsentBehavior: cfg.preConsentBehavior,
      debug: cfg.debug,
      // Declared persona rides core's session upsert + decide bodies.
      persona: cfg.persona,
    });
    activeClient = client;
    exposeGlobal(cfg);
    installSpaHooks();

    const slots = Object.entries(cfg.slots).map(([id, s]) => ({ id, dims: s.dims }));
    // Report our own build version so the server can flag version skew (e.g. a
    // customer's embedded snippet predating reorder-move-op support) — see
    // apps/api decide route + the dashboard Slots editor hint.
    // Only report a real, released version. The dev sentinel ('0.0.0-dev', used
    // in non-tsup builds) passes the server's semver check and would be persisted
    // as the project's snippet_version, permanently reading as "behind" (audit M12).
    const reportVersion = version !== '0.0.0-dev' ? { v: version } : {};
    // Configured sections that resolve on THIS page right now (missing ones are
    // dropped, not errored — the request describes what can actually move).
    // Fewer than two left → nothing to reorder, so the field is omitted and the
    // server's layout machinery never engages.
    const sectionIds = Array.from(resolveSections(document).keys());
    const decidePromise = client.decide({
      slots,
      ...reportVersion,
      ...(sectionIds.length >= 2 ? { sections: sectionIds } : {}),
      ...(registryMode ? { slotsFrom: 'registry' as const } : {}),
    });
    const outcome = await withTimeout(decidePromise, DECIDE_TIMEOUT_MS);
    // Everything downstream of a successful decide, extracted so the late-
    // arrival path below can run it too. Synchronous except for applyDecided's
    // own DOMContentLoaded deferral.
    const applyOutcome = (outcome: DecideOutcome): void => {
      const persona = client.getPersona();
      if (persona) activePersona = { persona: persona.persona, band: persona.band };
      else if (outcome.persona) activePersona = { persona: outcome.persona, band: 'low' };
      activeSlots = outcome.slots;
      // Registry mode: adopt the served slotConfig UNCONDITIONALLY (?? null) so a
      // decide response with no slotConfig CLEARS the cached one — otherwise an
      // unpublished/removed registry slot from the prior visit's snapshot keeps
      // being re-applied and re-persisted (audit). Declared-slot mode carries no
      // server slotConfig, so only overwrite when present.
      if (registryMode) activeSlotConfig = outcome.slotConfig ?? null;
      else if (outcome.slotConfig) activeSlotConfig = outcome.slotConfig;
      // Served palette wins over the snapshot's; an absent one leaves the cached
      // palette standing for this view (same one-visit-drift rule as layoutOrder
      // — the snapshot write below persists only what the server said).
      if (outcome.palette) setBlockPalette(outcome.palette);
      // Authoritative section order for this visit — corrects a pre-paint from a
      // stale snapshot (bounded apply is idempotent, so agreeing orders no-op).
      // An absent/empty layoutOrder deliberately leaves the pre-paint order
      // standing for this view, same as a decide timeout would; the snapshot
      // write below persists the server's answer, so it lasts one visit at most.
      activeLayoutOrder = outcome.layoutOrder ?? activeLayoutOrder;
      // Post-decide apply is authoritative — report any locator misses (not from
      // pre-paint or reapply, which would be noisy/premature). Collect the applied
      // (slot, arm, element) triples for per-option behavior signals.
      const applyDecided = (): void => {
        const appliedSlots: AppliedSlot[] = [];
        reportLocatorMisses(cfg, applyAll(document, {
          onApplied: (slotId, arm, el) => appliedSlots.push({ slotId, arm, el }),
        }));
        applyLayoutOrder(activeLayoutOrder, document);
        // From here copy/ops are confirmed by the server — a subsequent reapply()
        // (SPA nav / hydration) may safely restamp content, not just attributes.
        decided = true;
        // Per-option behavior signals on the applied slot elements — same privacy
        // gate as section capture; feeds the dashboard's per-option "how visitors
        // behave" (componentId = slotId, variantId = arm). Attached here, with
        // the apply, so a deferred apply binds detectors to the real elements.
        if (sectionCaptureAllowed()) {
          try {
            slotSignalsCleanup?.();
            slotSignalsCleanup = attachSlotSignals(activeClient!, cfg.apiKey, appliedSlots);
          } catch { /* fail-safe */ }
        }
      };
      if (document.readyState === 'loading') {
        // Async/GTM installs can resolve decide while the document is still
        // parsing: applying now would miss locators for not-yet-parsed elements
        // and beacon FALSE misses that suspend healthy slots (audit SNIP-2).
        // The pre-paint snapshot pass above is intentionally that early — it is
        // attributes-only flash prevention and reports nothing.
        document.addEventListener('DOMContentLoaded', applyDecided, { once: true });
      } else {
        applyDecided();
      }

      // Install editor-defined goal listeners (registry mode). Never for a
      // consent-off client; a DNT/consent-gated core client no-ops goal() anyway.
      // Saved at module scope so grantConsent() after a revoke can re-wire them.
      activeGoals = outcome.goals ?? null;
      if (outcome.goals && outcome.goals.length > 0 && cfg.consent !== false && activeClient) {
        try {
          goalListeners?.teardown();
          goalListeners = installGoalListeners(outcome.goals, activeClient, document, cfg.apiKey);
        } catch { /* fail-safe */ }
      }

      // Server-classified section map (persona-coverage) → capture typing hook.
      // Stored at module scope (route-scoped) so an SPA navigation can re-derive the
      // typeOf hook for the new path when capture restarts. Resolution reuses the
      // slot locator machinery inside startSectionCapture (resolveLocatorOne: id →
      // data-attr → selector, must be unique, fingerprint must match — never
      // guesses). Explicit data-sentient-type markup still wins inside capture.
      activeSectionMap =
        (outcome as { sectionMap?: Array<{ urlMatch: string; locator: unknown; type: string }> }).sectionMap ?? null;

      // Section capture (default ON). Hard-gated on the privacy state: never runs
      // for a DNT/GPC or consent-off visitor. Feeds the persona pipeline.
      // microSignals: no-code pages have no <Adaptive> components carrying their
      // own detectors, so the sections take them (rage click, quick exit, …).
      if (sectionCaptureAllowed()) {
        startSectionCapture();
      }

      dbg(cfg, 'applied', { persona: activePersona, slots: activeSlots, matches: matchCounts(cfg) });

      // A revoke that landed while decide was in flight must not re-persist the
      // snapshot: forget-me means the next visit starts clean, not
      // re-personalized from a decision the visitor already refused (audit SNIP-3).
      if (consentRevoked) return;
      writeSnapshot(cfg.apiKey, {
        v: 1,
        persona: activePersona?.persona ?? outcome.persona,
        band: activePersona?.band ?? 'low',
        slots: outcome.slots,
        // Live since B1.1: the next visit's pre-paint applies this order (bounded)
        // before decide returns, so a learned layout doesn't flash natural-order
        // first. null (no sections sent / older server) clears the cache.
        layoutOrder: outcome.layoutOrder,
        savedAt: Date.now(),
        ...(activeSlotConfig ? { slotConfig: activeSlotConfig } : {}),
        ...(outcome.palette ? { palette: outcome.palette } : {}),
      });
    };
    if (!outcome) {
      dbg(cfg, 'decide timeout/null — snapshot state stands', matchCounts(cfg));
      // SNIP-18: losing the 5s race used to DISCARD the still-in-flight decide,
      // so a roundtrip resolving at 6-8s meant TOTAL loss of the view — no
      // content, no goal wiring, no capture, no snapshot. Chain the late
      // arrival instead: applyOutcome reuses the whole post-decide path
      // (including applyDecided's DOM-readiness deferral) but never re-runs
      // the pre-paint snapshot pass — paint is long past. The snapshot the
      // late apply writes becomes the next view's state, which is exactly the
      // "snapshot state stands" contract working as intended: late
      // personalization beats total loss. Guards: `decided` (something else
      // already applied — never double-apply), `consentRevoked` (a revoke
      // that landed while waiting must win, audit SNIP-3), and a client swap
      // (revoke→grant re-inits; the refused visit's decision stays refused).
      // A late rejection stays swallowed — the host page must never see it.
      decidePromise
        .then((late) => {
          if (!late || decided || consentRevoked || activeClient !== client) return;
          applyOutcome(late);
          dbg(cfg, 'late decide applied', matchCounts(cfg));
        })
        .catch(() => undefined);
      return; // for THIS paint the snapshot state (or bare page) stands
    }
    applyOutcome(outcome);
  } catch {
    // fail-safe: never break the host page — but leave a callable no-op API
    // behind when the failure happened before exposeGlobal() ran (audit
    // SNIP-6; exposeNoopGlobal never overwrites a live api).
    exposeNoopGlobal();
  }
}

// Auto-run when loaded as a script tag on a configured page. Tests import run()
// directly; this guard is inert there because the module loads before tests set
// window.sentient. The window-level flag makes a double-embed (e.g. GTM + a
// hardcoded tag) run once instead of twice — two bundle instances would otherwise
// each auto-run, doubling decide calls, goal listeners and signal detectors
// (audit M11).
if (typeof window !== 'undefined' && (window as unknown as { sentient?: unknown }).sentient) {
  const w = window as unknown as { __sentientInitialized?: boolean };
  if (!w.__sentientInitialized) {
    w.__sentientInitialized = true;
    void run();
  }
}
