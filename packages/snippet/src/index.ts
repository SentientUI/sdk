import { consentWatcher, setConsentSrc } from './consent-lazy';
import { chunkSrc, loadChunk, setChunkSrc } from './chunk-src';
import type { PreviewHost } from './preview';
import { init, grantConsent as coreGrantConsent, forgetVisitor, forgetGeneration, routeKey, isDoNotTrackEnabled, applyNonce, setCspNonce, readSnapshot, writeSnapshot, type CompoundLocator, type DecideOutcome, type DecisionSnapshot, type GoalDefinition, type RenderCaps, type SentientClient, type SlotConfigEntry } from '@sentientui/core';
import { regionAddress } from '@sentientui/core/region';
import type { SemanticType, startEngagementCapture as StartCapture } from '@sentientui/core/engagement';
import { parseSnippetConfig, type SnippetConfig } from './config';
import { applyPersonaAttributes, applySlotAttributes, applySlotArms, applyRegistrySlots, type AttrSink } from './apply';
import { setBlockPalette, setBlockVocabulary, sweepOrphanBlocks } from './blocks';
import { attachSlotSignals, type AppliedSlot } from './slot-signals';
import { installGoalListeners, clearFiredGoals, type GoalListeners } from './goal-wiring';
import { isLocatorMiss, locatorOnPage, resolveLocatorOne } from './locator';
import { planReorder } from './layout-order';
import type { PrePaintRecord } from './prepaint-script';
import { readCachedEditorToken } from './editor-token';
import { takeHashParam } from './hash-param';

export { parseSnippetConfig } from './config';
export { applyPersonaAttributes, applySlotAttributes, applySlotArms, applyRegistrySlots } from './apply';
export { planReorder } from './layout-order';
// The consent-platform watcher `consentFrom` uses — for gating a site's other
// consent-bound scripts (an ad pixel) on the same platform. The presets load
// on first use (consent-lazy.ts); read() is null until they have.
export { consentWatcher } from './consent-lazy';
// NOT re-exported here on purpose: renderSnippetPrePaintScript's 2.6 KiB string
// would ride the always-on visitor bundle for the sake of an install-time
// generator that only ever runs in Node. It lives on '@sentientui/snippet/install'
// (src/install.ts) instead.

// Injected at build time from package.json (see tsup.config.ts `define`), so the
// version shipped inside the browser bundle always matches the released version
// and can never drift. Falls back to a dev sentinel when built without the define
// (e.g. unit tests run through vitest, which don't apply tsup's define).
declare const __SNIPPET_VERSION__: string;
export const version: string =
  typeof __SNIPPET_VERSION__ !== 'undefined' ? __SNIPPET_VERSION__ : '0.0.0-dev';

/**
 * Our identity for the session upsert's version-skew reporting, or undefined
 * when this is a dev build. Same rule as the decide-path `v` below: the
 * '0.0.0-dev' sentinel passes the server's semver check and would be persisted
 * as the project's SDK version, permanently reading as "behind" (audit M12).
 */
const SDK_IDENT = version !== '0.0.0-dev' ? { name: 'snippet', version } : undefined;
// Same rule for the decide-path version-skew report (see run()).
const REPORT_V = version !== '0.0.0-dev' ? { v: version } : {};

const DECIDE_TIMEOUT_MS = 5000;
const REAPPLY_DEBOUNCE_MS = 50;

// Pre-boot goal queue: a merchant stub
//   (see the README's stub, which also forwards to this API after boot)
// can record conversions before this bundle loads. Captured at module-eval
// time — tsup's IIFE assignment replaces the global right AFTER the module
// body runs, so this is the last moment the stub is visible.
// The stub may queue ['grantConsent'] / ['revokeConsent'] too: a CMP that
// answers before the snippet has loaded otherwise called a method that didn't
// exist yet, and an accept given then was lost for the page view (review R8 #7).
type PrebootCall = ['goal', string, Record<string, unknown>?] | ['grantConsent'] | ['revokeConsent'];
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
// Each start (and each teardown) bumps this; a start whose chunk lands after a
// newer one was asked for is dropped. The LATEST wins — the post-decide start
// carries the server section map, and the grant-time one (no map yet) used to
// win by landing first (review #2).
let captureGen = 0;
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
// True while this run is an editor or preview session: those never track, so
// the consent watcher is not installed (it would grant or forget as a side effect).
let qaMode = false;
// The project's forget generation when the current client was created (or
// upgraded): the snippet's own snapshot writes happen only while it is
// unchanged, so a forget-me can't be written back by an answer that arrives
// after it — even once a later grant has created a new client (grader NEW-1).
let clientGen = 0;
const mayWrite = (apiKey: string): boolean => forgetGeneration(apiKey) === clientGen;
// Unsubscribes the consent-platform watcher (consentFrom), per run().
let stopConsentWatch: (() => void) | null = null;
// True only between revokeConsent() and the next grantConsent()/run(). It is
// what distinguishes "client destroyed by revocation, grant should re-init"
// from "client never existed" (editor/preview modes expose the API with no
// client, and grant must NOT mint a tracking client there).
let consentRevoked = false;

// --- Registry scoping (phantom trials) -------------------------------------
// Every decided registry component is a close-out TRIAL (CONTRACTS.md §2). A
// bare `slotsFrom: 'registry'` decided every published component on every page
// view, including ones whose element is not on the page, so each component's
// denominator was diluted by views that could never have shown it. The snippet
// now resolves the published locators first and decides only what is here.
type RegistryLocator = { id: string; locator: CompoundLocator | null };
// Published locators, kept for the page lifetime so SPA navigations can
// re-resolve without refetching. null = not registry mode, or the fetch failed
// (then nothing is decided on navigation either — no locators, no trials).
let registryLocators: RegistryLocator[] | null = null;
// Registry ids already decided on this page load (initial + SPA decides).
let decidedIds: string[] = [];
// The pathname the locator list was last resolved against.
let routePath: string | null = null;
// Last snapshot this page load wrote, so an SPA decide can extend it.
let lastSnap: DecisionSnapshot | null = null;
// Stops the bounded late-render watch (see watchRoute), or null when idle.
let stopWatch: (() => void) | null = null;
const WATCH_MS = 3000;
const WATCH_DEBOUNCE_MS = 100;

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
  opts?: {
    contentAndOps?: boolean;
    onApplied?: (slotId: string, arm: string, el: Element) => void;
    onAttr?: AttrSink;
  },
): string[] {
  if (!activeCfg) return [];
  if (activeCfg.personaAttributes && activePersona) {
    applyPersonaAttributes(activePersona.persona, activePersona.band, doc, opts?.onAttr);
  }
  applySlotAttributes(activeSlots, activeCfg.slots, doc, opts?.onAttr);
  applySlotArms(activeSlots, activeCfg.slots, doc, opts?.onAttr);
  // Registry-mode slots carry their own target/content (no page-declared decl).
  // Returns the slot ids whose locator found nothing (a health signal).
  if (activeSlotConfig) {
    // Persona rides along as reveal provenance — recorded on the element as a
    // data attribute for devtools and the editor, never rendered to a visitor.
    return applyRegistrySlots(activeSlots, activeSlotConfig, doc, {
      ...opts,
      onDrift: (slotId, expectedFp) => activeClient?.reportDrift?.(slotId, expectedFp, pageFps[slotId] ?? null, 'fp_mismatch'),
      ...(activePersona ? { persona: activePersona.persona } : {}),
    });
  }
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
 *  an edited `sections` config can never wedge a half-reordered page.
 *
 *  The move computation itself lives in planReorder() so the inline pre-paint
 *  script's hand-minified copy can be tested against the same fixtures — see
 *  layout-order.ts. */
function applyLayoutOrder(order: string[] | null | undefined, doc: Document): void {
  try {
    // Cheap bail before touching the DOM at all: reapply() runs this on every
    // SPA navigation, and a site with no served order must not pay a
    // querySelectorAll per configured section for nothing.
    if (!order || order.length < 2) return;
    // Successive insertBefore within the shared parent — the registry move-op
    // primitive. An already-ordered prefix plans no moves, so this is idempotent
    // on reapply.
    for (const m of planReorder(order, resolveSections(doc)) ?? []) {
      m.before.parentNode?.insertBefore(m.el, m.before);
    }
  } catch {
    /* fail-safe */
  }
}

/**
 * Undo whatever the inline pre-paint script stamped that this bundle's own
 * authoritative pre-decide pass did NOT re-apply.
 *
 * The inline script (spec 2026-09-07) works with less information than we do: it
 * runs mid-parse, and it cannot verify a registry locator's fingerprint before
 * the element's children exist. So it can stamp an element we would not, or an
 * element that stopped being the right one. This is the correction — the bundle
 * stays the single authority, and the whole divergence lives inside one page
 * load.
 *
 * `confirmed` is every (element, attribute) our pass just wrote. The comparison
 * is a linear scan on purpose: both lists are slot-count sized, and a Map keyed
 * by Element costs more bytes than it saves at this scale.
 */
function reconcilePrePaint(pp: PrePaintRecord, confirmed: Array<[Element, string]>, doc: Document): void {
  const agreed = (el: Element, attr: string): boolean =>
    confirmed.some(([e, a]) => e === el && a === attr);
  try {
    // Tolerate a malformed / higher-version record: read only the fields we know,
    // and only when they have the shape v1 promised.
    if (Array.isArray(pp.stamped)) {
      for (const entry of pp.stamped) {
        if (!Array.isArray(entry)) continue;
        const [el, attr, prior] = entry;
        if (!el || typeof attr !== 'string' || agreed(el, attr)) continue;
        if (prior === null || prior === undefined) el.removeAttribute(attr);
        else el.setAttribute(attr, prior);
      }
    }
    // <html> persona attributes: prior is always null (the inline script is
    // single-writer and only sets them when absent), so disagreement = remove.
    if (Array.isArray(pp.html)) {
      for (const attr of pp.html) {
        if (typeof attr !== 'string' || agreed(doc.documentElement, attr)) continue;
        doc.documentElement.removeAttribute(attr);
      }
    }
  } catch {
    /* fail-safe */
  }
}

/** The inline pre-paint record, or null when this install has no inline script
 *  (the two-tag install, which must keep working forever) or left garbage. */
function readPrePaint(): PrePaintRecord | null {
  try {
    const pp = (window as unknown as { __sntPP?: PrePaintRecord }).__sntPP;
    return pp && typeof pp === 'object' && typeof pp.v === 'number' ? pp : null;
  } catch {
    return null;
  }
}

/**
 * Core ingest URL for a configured API base. `apiBase` was honored by the
 * editor overlay, engagement capture, and the locator-miss beacon — but NOT by
 * core init(), so a self-hosted/local install split its traffic: section-map
 * hit the configured API while sessions/decide/events silently went to the
 * hosted default. Undefined (hosted default) when no override is configured.
 */
function ingestUrlFrom(cfg: SnippetConfig): string | undefined {
  return cfg.apiBase ? `${cfg.apiBase.replace(/\/+$/, '')}/v1/events` : undefined;
}

function apiBase(cfg: SnippetConfig): string {
  return cfg.apiBase ?? 'https://api.sentient-ui.com';
}

/** The project's published component locators, or null on any failure. */
function fetchLocators(cfg: SnippetConfig): Promise<RegistryLocator[] | null> {
  return Promise.resolve()
    .then(() => fetch(`${apiBase(cfg)}/v1/registry/locators`, { headers: { authorization: `Bearer ${cfg.apiKey}` } }))
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { slots?: unknown } | null) => (Array.isArray(d?.slots) ? (d!.slots as RegistryLocator[]) : null))
    .catch(() => null);
}

/** [ids whose element is on this page, ids whose absence is a locator miss].
 *  `locator: null` targets <html>, which is always on the page. */
function scanLocators(list: RegistryLocator[], doc: Document): [string[], string[]] {
  const on: string[] = [];
  const missed: string[] = [];
  for (const s of list) {
    try {
      if (typeof s?.id !== 'string') continue;
      if (!s.locator || locatorOnPage(s.locator, doc)) on.push(s.id);
      else if (isLocatorMiss(s.locator, doc)) missed.push(s.id);
    } catch { /* fail-safe — a malformed entry is neither decided nor a miss */ }
  }
  return [on, missed];
}

// Fingerprints of THIS page's regions, taken at decide time before any apply
// mutates it: what the decide declares, and the observed value in a drift
// report. The snippet carries only the addressing half of a skeleton capture
// (bundle size); full skeletons for snippet regions come from the on-site
// editor session, which is trusted and loads the descriptive half lazily.
const pageFps: Record<string, string> = {};

/** What each decided slot on this page can render (CONTRACTS §2). The snippet
 *  never renders form trees and its content path always lands (textContent
 *  fallback), so the fingerprint is the only per-page variable. Must run
 *  before any apply — an applied arm is not the baseline. */
function renderFor(ids: string[], doc: Document): Record<string, RenderCaps> {
  const out: Record<string, RenderCaps> = {};
  for (const id of ids) {
    const loc = registryLocators?.find((l) => l.id === id)?.locator;
    const el = loc ? resolveLocatorOne(loc, doc) : null;
    const addr = el ? regionAddress(el) : null;
    const fp = addr && 'fp' in addr ? addr.fp : undefined;
    if (fp) pageFps[id] = fp;
    // compose: true — this bundle renders Redesign trees (`like` + surface).
    out[id] = { ...(fp ? { fp } : {}), forms: false, compose: true, content: true };
  }
  return out;
}

/** Only the ids this page asked the server about, or null when none came back.
 *  The server already scopes to registrySlotIds; filtering here too keeps "not
 *  decided ⇒ not applied" true against a response that ignored the field. */
function pickConfig(cfg: Record<string, SlotConfigEntry> | undefined, ids: string[]): Record<string, SlotConfigEntry> | null {
  let out: Record<string, SlotConfigEntry> | null = null;
  for (const id of ids) if (cfg?.[id]) (out ??= {})[id] = cfg[id]!;
  return out;
}

/**
 * SPA navigation in registry mode: on a real path change (and once after the
 * initial decide applies), resolve the cached locator list for this page via
 * watchRoute. Runs only once the visit is decided — a navigation during the
 * initial decide is caught up by the call at the end of applyOutcome.
 */
// A full decide for the current page, applied like the visit's first (set by
// run()). Used when the first one never landed: consent arrived after an SPA
// navigation (core dropped the held decide), or it failed outright — without
// this a failed first decide left the whole SPA visit undecided, since route
// decides require `decided` (grader NEW-6).
let redecide: ((nav?: boolean) => void) | null = null;

function syncRoute(): void {
  if (!decided) {
    if (redecide && routePath !== routeKey()) redecide(true);
    return;
  }
  if (!registryLocators || routePath === routeKey()) return;
  routePath = routeKey();
  watchRoute();
}

/**
 * Resolve the cached locators now and, while published components that are not
 * decided yet still match nothing, keep watching the DOM for a bounded window.
 * Hydrating frameworks and client routers render AFTER DOMContentLoaded / the
 * history call; before page scoping, a late-rendered component still applied on
 * a later reapply because its config was already there, so resolving only
 * once would have silently lost it. Newly resolving ids get one claimed scoped
 * decide per debounced check. Misses are classified once, when the window ends
 * (or nothing is pending): a slow render is not a page-scoped miss.
 */
function watchRoute(): void {
  stopWatch?.();
  const cfg = activeCfg;
  const list = registryLocators;
  if (!cfg || !list) return;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let obs: MutationObserver | undefined;
  const stop = (): void => {
    clearTimeout(debounce);
    clearTimeout(windowEnd);
    obs?.disconnect();
    if (stopWatch === stop) stopWatch = null;
  };
  let seenOn: Set<string> | null = null;
  const check = (final?: boolean): void => {
    const [on, missed] = scanLocators(list, document);
    const ids = on.filter((id) => !decidedIds.includes(id));
    // An ALREADY-decided component that renders late (return to a route it
    // was decided on earlier): decideLate re-applies only what it decides, and
    // the route-change reapply ran before the router rendered, so nothing
    // else would stamp its config. Restamp when such an id newly resolves.
    if (seenOn !== null && on.some((id) => !seenOn!.has(id) && !ids.includes(id))) reapply();
    seenOn = new Set(on);
    if (ids.length > 0) void decideLate(ids).catch(() => undefined);
    // Pending = still worth waiting for: an undecided component not on the
    // page yet, OR anything currently classified as a miss. The second clause
    // matters for ids decided on an EARLIER route: they are not "undecided",
    // so without it the first check after a client-side navigation — run
    // before the router has rendered the new page — ended the window at once
    // and reported the page-scoped, already-decided component as absent.
    // Same rule for both: a slow render is not a miss; the window end decides.
    if (final || (missed.length === 0 && !list.some((e) => !on.includes(e.id) && !decidedIds.includes(e.id)))) {
      stop();
      reportLocatorMisses(cfg, missed);
    }
  };
  const windowEnd = setTimeout(() => check(true), WATCH_MS);
  stopWatch = stop;
  check();
  // Nothing pending after the first look: no observer at all.
  if (stopWatch !== stop) return;
  try {
    obs = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(check, WATCH_DEBOUNCE_MS);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch { /* fail-safe — no observer: the window end still classifies */ }
}

/** One scoped decide for ids that just resolved, merged into (never replacing)
 *  the visit's state — the core client keeps earlier ids sticky per session. */
/** (Re)install the editor-defined goal listeners — one place for the four
 *  paths that wire them (initial decide, route decide, both grant paths). */
function wireGoals(goals: GoalDefinition[] | null | undefined, client: SentientClient | null): void {
  if (!goals || goals.length === 0 || !client || !activeCfg) return;
  try {
    goalListeners?.teardown();
    goalListeners = installGoalListeners(goals, client, document, activeCfg.apiKey);
  } catch { /* fail-safe */ }
}

async function decideLate(ids: string[]): Promise<void> {
  const cfg = activeCfg;
  const client = activeClient;
  if (!cfg || !client) return;
  // Claimed before the await so a later check cannot decide the same ids
  // twice; released on failure so a later navigation retries.
  decidedIds = decidedIds.concat(ids);
  // No 5 s race: a sent decide is booked server-side, so its answer is
  // applied whenever it lands (core frees only a dead connection) — racing it
  // dropped slow answers and left trials for arms never shown (grader F5).
  const out = await client.decide({ slotsFrom: 'registry', registrySlotIds: ids, render: renderFor(ids, document), ...REPORT_V });
  if (!out) decidedIds = decidedIds.filter((id) => !ids.includes(id));
  if (!out || consentRevoked || activeClient !== client) return;
  activeSlots = { ...activeSlots, ...out.slots };
  // The route decide may be the visit's FIRST decision (consent arrived after
  // a navigation): wire the editor goals it carries, as applyOutcome does.
  if (!goalListeners && out.goals && (cfg.consent !== false || consentGranted)) wireGoals((activeGoals = out.goals), client);
  const picked = pickConfig(out.slotConfig, ids);
  if (picked) activeSlotConfig = { ...activeSlotConfig, ...picked };
  reapply();
  dbg(cfg, 'late decide', ids);
  if (lastSnap) {
    if (mayWrite(cfg.apiKey)) writeSnapshot(cfg.apiKey, lastSnap = {
      ...lastSnap,
      slots: activeSlots,
      savedAt: Date.now(),
      ...(activeSlotConfig ? { slotConfig: activeSlotConfig } : {}),
    });
  }
}

/** Best-effort beacon of locator misses so the worker can suspend broken slots. */
function reportLocatorMisses(cfg: SnippetConfig, slots: string[]): void {
  if (slots.length === 0) return;
  try {
    void fetch(`${apiBase(cfg)}/v1/locator-miss`, {
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
  // Engagement capture is its own chunk (engagement.global.js, fetched at boot
  // in parallel with the decide — capture waits for the decide's section map
  // anyway), so the always-on bundle has room for consent fixes (audit S24).
  const client = activeClient;
  const gen = ++captureGen;
  lastCapturePath = window.location.pathname;
  void loadChunk<{ startEngagementCapture: typeof StartCapture }>('engagement.global.js', '__sentientEngagement').then((m) => {
    // Superseded, stopped or revoked while the chunk was in flight.
    if (!m || gen !== captureGen || activeClient !== client || !client || !sectionCaptureAllowed()) return;
    try {
      sectionCaptureCleanup?.();
      sectionCaptureCleanup = m.startEngagementCapture(client, {
        apiKey: activeCfg!.apiKey, apiBase: activeCfg!.apiBase, doc: document, microSignals: true,
        ...(typeOf ? { typeOf } : {}),
      });
    } catch { /* fail-safe */ }
  });
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
        captureGen++;
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
    syncRoute();
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
// Editor asset URL: explicit config wins; otherwise beside the snippet's own
// <script src> (chunk-src.ts, which also carries its integrity when pinned).
/** Load the separate editor overlay bundle (zero bytes on the normal path).
 *  Hands it the one-time code (fresh open) or the cached token (reload) + API
 *  base via a global, then injects the script tag. The code → token exchange
 *  lives in the editor bundle, not here: this file is the always-on budget. */
function loadEditor(cfg: SnippetConfig, token: string | null, code: string | null): void {
  try {
    (window as unknown as { __sentientEditor?: unknown }).__sentientEditor = {
      token,
      code,
      apiBase: apiBase(cfg),
    };
    // No <meta name="referrer" content="no-referrer"> any more: it guarded a
    // token that sat in the QUERY, which rides the Referer. Nothing secret is
    // in the URL now (a fragment is never part of a Referer, and the code is
    // stripped above), while the meta degraded the site's own referrer policy
    // for the whole editor session.
    const chunk = cfg.editorSrc ? { src: cfg.editorSrc } : chunkSrc('editor.global.js');
    if (!chunk) {
      // No resolvable editor bundle URL — surface it instead of leaving a blank
      // page (the editor's own toast can't fire because its code never loads).
      showEditorLoadNotice();
      return;
    }
    const s = applyNonce(document.createElement('script'));
    setChunkSrc(s, chunk);
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

function showEditorLoadNotice(): void {
  try {
    if (document.getElementById(EDITOR_LOAD_NOTICE_ID)) return;
    const box = document.createElement('div');
    box.id = EDITOR_LOAD_NOTICE_ID;
    box.textContent = 'Couldn’t load the editor — check your connection and reopen it from your dashboard.';
    // One declaration string (not a style object): this path is operator-only
    // and its bytes ride every visitor's bundle (the preview banner that
    // shared the old style object moved to preview.global.js).
    box.style.cssText =
      'position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:320px;padding:14px 16px;border-radius:14px;' +
      'background:#111827;color:#fff;font:13px/1.45 system-ui,sans-serif;border:1px solid rgba(245,158,11,.6);cursor:pointer';
    box.onclick = () => box.remove();
    (document.body ?? document.documentElement).appendChild(box);
    setTimeout(() => box.remove(), 10000);
  } catch {
    /* fail-safe */
  }
}

/** Load preview.global.js and hand it what it drives. A chunk that can't
 *  load leaves the page as the visitor's own markup — with the page API, like
 *  every other preview failure. */
function runPreviewChunk(cfg: SnippetConfig): Promise<boolean> {
  const host: PreviewHost = {
    cfg,
    apiBase: apiBase(cfg),
    set(next) {
      if (next.slots !== undefined) activeSlots = next.slots;
      if (next.slotConfig !== undefined) activeSlotConfig = next.slotConfig;
      if (next.persona !== undefined) activePersona = next.persona;
      if (next.decided) decided = true;
      if (next.look) {
        setBlockPalette(next.look.palette as import('@sentientui/core').SitePalette | undefined);
        setBlockVocabulary(next.look.vocabulary as import('@sentientui/core').StyleVocabulary | undefined);
      }
    },
    apply: () => applyAll(document),
    installSpaHooks,
    exposeGlobal: () => {
      qaMode = true;
      exposeGlobal(cfg);
    },
    dbg: (...a) => dbg(cfg, ...a),
  };
  // A QA link whose chunk can't load: the operator's page stays their own
  // markup, untracked, like every other preview failure.
  return loadChunk<{ runPreview(h: PreviewHost): Promise<boolean> }>('preview.global.js', '__sentientPreview')
    .then((mod) => (mod ? mod.runPreview(host) : Promise.reject()))
    .catch(() => {
      host.exposeGlobal();
      dbg(cfg, 'preview chunk unavailable — page left as-is');
      return true;
    });
}

function exposeGlobal(cfg: SnippetConfig): void {
  /** Stop tracking this page view; `forget` also deletes the visitor. */
  const stopTracking = (forget: boolean): void => {
    try {
      // Detach capture observers/listeners before destroying the client so a
      // revoke leaves no IntersectionObserver / visibilitychange / pagehide
      // listeners running (they'd otherwise leak until page unload).
      sectionCaptureCleanup?.();
      sectionCaptureCleanup = null;
      captureGen++;
      lastCapturePath = null;
      slotSignalsCleanup?.();
      slotSignalsCleanup = null;
      stopWatch?.();
      // Tear down the editor-defined goal listeners too — otherwise the
      // delegated click/submit/popstate handlers keep calling goal() on the
      // client we're about to destroy (leak on a destroyed client, audit).
      goalListeners?.teardown();
      goalListeners = null;
      // Forget the fired-goal latches too: forget-me must be total, and the
      // `_snt_fired_goals_*` sessionStorage entry otherwise kept naming the
      // visitor's conversions after revoke (audit SNIP-12, privacy).
      if (forget) clearFiredGoals(typeof window !== 'undefined' ? window : null, cfg.apiKey);
      consentGranted = false;
      consentRevoked = true;
      // forget = the visitor refused: delete the identity and everything
      // stored (destroy). Otherwise only stop: dispose keeps the identity,
      // so a re-grant resumes the same visitor.
      if (forget) {
        // The forgotten decision must not ride a later route decide's
        // snapshot write into the next identity (review #3).
        lastSnap = null;
        activePersona = null;
        // No live client (paused earlier, or never granted on a manual
        // gate): forget-me still deletes what an earlier visit stored — it
        // used to reach nothing (grader F2 / review #3).
        if (activeClient) activeClient.destroy();
        else forgetVisitor(cfg.apiKey);
      } else activeClient?.dispose();
      // Null the reference: the destroyed client is not just inert, it is
      // gone from core's registry, so keeping it wired left grantConsent()
      // warning "called before init()" and capture recording into a dead
      // client — revoke→grant permanently killed tracking until reload.
      // grantConsent() above treats null as "re-init fresh".
      activeClient = null;
    } catch {
      /* fail-safe */
    }
  };
  const api = {
    /** Watch a consent platform ('cookiebot' | 'onetrust' | 'cookieyes' |
     *  'tcf' | 'google-consent-mode' | { cmp, … } | { cookie, check, event }):
     *  `read()` → true/false/null, `subscribe(cb)` → unsubscribe. Lets a
     *  no-code site gate its other scripts on the same platform the snippet
     *  follows. The presets are a lazy chunk: `read()` is null until it has
     *  loaded, and subscribers are called when it has — subscribe, don't
     *  read once at load. */
    consentWatcher,
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
        // A released gated client (destroyed by a platform refusal) left
        // core's grantConsent() registry, so it can't be upgraded any more:
        // a later accept re-inits like a post-revoke grant (review R8 #6).
        if ((!activeClient && consentRevoked) || activeClient?.released) {
          // A prior revokeConsent() destroyed the client — core deleted its
          // registry entry, so coreGrantConsent() would warn "called before
          // init()" and every later goal()/track() would silently hit a dead
          // client until a full reload. Resuming means a FRESH init with
          // consent granted: revoke deliberately forgot the visitor (destroy
          // cleared the identity cookie/storage), so this mints a new identity
          // rather than resurrecting the severed one — that forgetting is the
          // point of revocation, not a bug to undo. init() itself still honors
          // DNT/GPC, so a global opt-out cannot be overridden here.
          clientGen = forgetGeneration(cfg.apiKey);
          activeClient = init({
            apiKey: cfg.apiKey,
            consent: true,
            preConsentBehavior: cfg.preConsentBehavior,
            debug: cfg.debug,
            persona: cfg.persona,
            ingestUrl: ingestUrlFrom(cfg),
            ...(SDK_IDENT ? { sdk: SDK_IDENT } : {}),
          });
          // Re-install the editor-defined goal listeners revoke tore down —
          // from the visit's served decision, never a new decide.
          wireGoals(activeGoals, activeClient);
        } else {
          // Normal path: the client is a live pre-consent proxy — upgrade it in
          // place and flush core's queued events.
          // Re-read the forget generation only when this actually upgraded a
          // gated client: a repeated grant on a tracking client must not
          // re-arm writes after a forget made elsewhere (review R7 #5).
          const upgrading = activeClient?.gated === true;
          coreGrantConsent(cfg.apiKey);
          if (upgrading) clientGen = forgetGeneration(cfg.apiKey);
          // Install the editor-defined goal listeners run() withheld for a
          // consent:false boot — without this, a visit that granted consent
          // after load recorded ZERO click/submit/url/scroll goals (audit
          // SNIP-1: the missing half of the capture-after-consent fix; the
          // revoke→grant branch above already re-wires them from the same
          // module-scope activeGoals, never a new decide).
          wireGoals(activeGoals, activeClient);
        }
        consentRevoked = false;
        // Paused or revoked before any decision landed: decide this page now
        // with the new client (redecide acts only when no answer was ever
        // received in this run, and never on a still-gated client).
        redecide?.();
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
      stopTracking(true);
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
  // Kept aside so a second embed of the bundle can restore it (see the guard).
  (window as unknown as { __sentientApi?: unknown }).__sentientApi = api;
  // Follow the consent platform both ways: a later "yes" grants without a
  // reload, a later "no" revokes (the platform's word, re-read on each of its
  // signals — never an event payload). Unknown changes nothing.
  // Not in the QA modes (editor, preview): they never track, so following
  // the platform there would only grant/forget as a side effect.
  if (cfg.consentFrom && !stopConsentWatch && !qaMode) {
    try {
      const watcher = consentWatcher(cfg.consentFrom);
      // Live state, not a local flag: a site that ALSO calls grantConsent()
      // or revokeConsent() by hand used to desync it (review #4).
      let lastRefused = false;
      // Same rule as the React provider: once the platform has answered in
      // this page view, "no answer" again (a custom banner's reset deleting
      // its cookie) pauses. As "no change" it kept tracking a visitor who had
      // just withdrawn (grader N11-2).
      let answered = false;
      const tracking = (): boolean =>
        !!activeClient &&
        !consentRevoked &&
        // `gated` is set by core's consent-gated client; a tracking client has
        // none, and then the consent state decides.
        (activeClient.gated === undefined ? cfg.consent !== false || consentGranted : !activeClient.gated);
      stopConsentWatch = watcher.subscribe(() => {
        try {
        const read = watcher.read();
        if (read !== null) answered = true;
        const now = read ?? (answered ? false : null);
        const granted = tracking();
        // A recorded refusal with no live tracking client (the "no" was given
        // before this page, where the SDK wasn't watching) still forgets —
        // revokeConsent() below only reaches a visitor tracked on THIS page
        // (audit N2). refused() is false while the platform is loading or its
        // banner is up, so a consented visitor is never wiped by a slow CMP.
        // …and never while the platform reads granted (a custom `refused`, or
        // Shopify's two signals, disagreeing): that re-identified a consented
        // visitor on every page load (review #4).
        const refusedNow = !granted && now !== true && watcher.refused();
        // On a change only: Consent Mode calls back on every dataLayer push,
        // and each call used to forget (and bump the generation) again (N7-10).
        if (refusedNow && !lastRefused) {
          // A gated client's destroy() also drops the goals and decide it
          // was holding — a refusal must not let them replay on a later
          // accept in the same page view (grader F4).
          if (activeClient?.gated) activeClient.destroy();
          else forgetVisitor(cfg.apiKey);
          clearFiredGoals(window, cfg.apiKey);
          // In-memory state from before a pause must not ride a later route
          // decide's snapshot write into the next identity (review R7 #1).
          lastSnap = null;
          activePersona = null;
        }
        lastRefused = refusedNow;
        if (now === true && !granted) {
          api.grantConsent();
        } else if (now === false && granted) {
          // Forget only a recorded refusal. A consented visitor reopening the
          // TCF banner (cmpuishown reads false) was fully forgotten even if they
          // closed it unchanged; that only gates now — the client is disposed
          // and the identity kept (review M2).
          const forget = watcher.refused();
          stopTracking(forget);
          // This forget already ran: without the latch the next callback
          // (now untracked) read a fresh refusal and forgot again, bumping
          // the forget generation a second time (review R8 #4).
          if (forget) lastRefused = true;
        }
        } catch {
          /* a throwing platform API never breaks the site (SN-5) */
        }
      });
    } catch {
      /* a broken platform API never breaks the site */
    }
  }
  // Replay conversions recorded on a pre-boot stub (captured at module eval).
  for (const call of prebootQueue.splice(0)) {
    try {
      if (call[0] === 'goal') api.goal(call[1], call[2]);
      // In order, so goal → grant → goal keeps its meaning. Only with a client
      // to act on (the QA modes expose the API without one).
      else if (call[0] === 'grantConsent' && activeClient) api.grantConsent();
      else if (call[0] === 'revokeConsent' && activeClient) api.revokeConsent();
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
      // Consent reads don't depend on a valid config — keep them working.
      consentWatcher,
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
/** A Shopify Online Store page: Shopify defines `Shopify.shop` in the head
 *  of every storefront before app embeds and deferred scripts run. */
function isShopifyStorefront(): boolean {
  try {
    const shop = (window as unknown as { Shopify?: { shop?: unknown } }).Shopify;
    return typeof shop?.shop === 'string' && shop.shop !== '';
  } catch {
    return false;
  }
}

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
    // A consent platform decides the initial gate (an explicit `consent` wins).
    // Unknown (platform not loaded yet) boots gated; the watcher installed in
    // exposeGlobal() grants the moment the platform says yes.
    stopConsentWatch?.();
    stopConsentWatch = null;
    // On a Shopify storefront with no consent configured, Shopify's Customer
    // Privacy API is the consent source: Shopify's own banner and every
    // Shopify CMP app report into it, and it already applies the merchant's
    // region settings. Without this an EU store on Shopify's banner was
    // tracked from the first page view (audit P0-10). An explicit `consent`
    // or `consentFrom` still wins.
    if (!cfg.consentFrom && cfg.consent === undefined && isShopifyStorefront()) cfg.consentFrom = 'shopify';
    setConsentSrc(cfg.consentSrc);
    setCspNonce(cfg.nonce);
    qaMode = false;
    // Fresh visit decision: withhold content restamping from reapply() until this
    // run's /v1/decide confirms it (see the `decided` declaration).
    decided = false;
    redecide = null;
    activeLayoutOrder = null;
    // The previous run's served slots: a navigation's reapply() stamped them
    // onto this run's page before its own decide landed (the 1-in-16 flake in
    // consent-boot "a gated boot never applies the stored snapshot" — grader
    // R8 NEW-4; one run per page in production).
    activeSlots = {};
    activeSlotConfig = null;
    setBlockPalette(null);
    setBlockVocabulary(null);
    // Reset live-consent for this visit; only a later grantConsent() re-opens it.
    consentGranted = false;
    consentRevoked = false;
    activeGoals = null;
    registryLocators = null;
    decidedIds = [];
    routePath = null;
    lastSnap = null;
    stopWatch?.();
    // A re-run stops the previous visit's capture: overwriting the handle (as
    // a synchronous start used to) leaked its observers and listeners.
    sectionCaptureCleanup?.();
    sectionCaptureCleanup = null;
    captureGen++;
    lastCapturePath = null;

    // Editor mode — load the on-site editor overlay and stop. No decide,
    // events, snapshot, or slot apply (the editor suppresses all tracking
    // exactly like preview mode). A fresh open carries a one-time code in the
    // FRAGMENT (#sentient_editor_code=, grade E1): the old ?sentient_editor=
    // query put the 30-minute publish-capable token in server/CDN logs,
    // analytics page URLs and Referer before this line could strip it. The
    // editor bundle trades the code for the token and caches it in
    // sessionStorage, so a reload or another page in this tab re-enters editor
    // mode from the cache instead.
    // (No window guard: takeHashParam's own try turns a missing `location`
    // into null — the guard was bytes the always-on budget doesn't have.)
    const editorCode = takeHashParam('sentient_editor_code');
    const editorToken = editorCode ? null : readCachedEditorToken();
    if (editorCode || editorToken) {
      loadEditor(cfg, editorToken, editorCode);
      // Expose the page API even though tracking is suppressed: merchant code
      // calling SentientSnippet.goal(...) otherwise THROWS in this mode (the
      // build-time global has no goal method), and the pre-boot stub queue is
      // stranded. With no activeClient every method is a harmless no-op —
      // exactly the tracking suppression editor mode promises — and the queue
      // drains into those no-ops instead of replaying on a later real visit.
      qaMode = true;
      exposeGlobal(cfg);
      dbg(cfg, 'editor mode');
      return;
    }

    // Preview modes (?sentient_preview= forced arms, ?sentient_persona=
    // audience simulation) — event-free QA that ordinary visitors never hit,
    // so they live in the lazy preview.global.js chunk (audit S24: the
    // always-on bundle pays for new fixes by moving rare paths out).
    // A param the chunk can't parse falls through to an ordinary visit.
    if (typeof window !== 'undefined' && /[?&]sentient_(preview|persona)=[^&]/.test(window.location.search)) {
      if (await runPreviewChunk(cfg)) return;
    }

    // The initial consent gate — after the QA modes above, which never track
    // and must not touch consent at all (no chunk fetch, no grant, no forget).
    // An explicit `consent` wins; unknown (platform not loaded yet) boots
    // gated, and the watcher in exposeGlobal() grants the moment it says yes.
    if (cfg.consentFrom && cfg.consent === undefined) {
      try {
        cfg.consent = consentWatcher(cfg.consentFrom).read() === true;
      } catch {
        cfg.consent = false;
      }
    }
    // Fetch the capture chunk now, in parallel with session + decide, so it is
    // there when capture starts (after the decide). Only for a visit that may
    // be tracked; a consent-gated one fetches it after the grant.
    if (cfg.consent !== false && cfg.sectionCapture !== false && !isDoNotTrackEnabled()) {
      void loadChunk('engagement.global.js', '__sentientEngagement');
    }

    // Registry mode: bare `{ apiKey }` (no declared slots) opts in by default;
    // an explicit `registry` flag overrides either way.
    const registryMode = cfg.registry ?? Object.keys(cfg.slots).length === 0;
    // Declaring ANY slot silently turned dashboard-published versions off: a
    // site that added one `slots` entry saw its published components stop
    // applying with no signal at all. The default stays (changing it would flip
    // serving for existing installs); debug installs at least get told why.
    if (cfg.registry === undefined && !registryMode) {
      dbg(cfg, 'slots declared without registry: true, so dashboard-published components are not applied');
    }
    // Registry mode: fetch the published locators NOW, in parallel with the
    // pre-paint pass and core init (decide awaits the session upsert anyway),
    // so scoping the decide to this page adds no serial round trip.
    const locatorsPromise = registryMode ? fetchLocators(cfg) : null;

    // Hand-off from the inline pre-paint script (spec 2026-09-07 §3.4). Null on
    // a two-tag install — the config-plus-loader install must keep working
    // unchanged, forever — and on a malformed or higher-version record.
    const prePaint = readPrePaint();
    // Stop its observer FIRST: from here this bundle is the authority, and a live
    // observer would keep stamping behind the reconcile below.
    try { prePaint?.stop?.(); } catch { /* fail-safe */ }

    // Not for a visit that may not be tracked (consent: false, a consent
    // platform that hasn't granted — every consentFrom boot — or DNT/GPC):
    // reading the device's stored decision before consent is what the gate
    // exists to prevent (grader F3). The reconcile below then also reverts
    // anything the inline tag stamped from it. A consented visitor's
    // decision arrives with the decide once the platform grants.
    const snap = cfg.consent !== false && !isDoNotTrackEnabled() ? readSnapshot(cfg.apiKey) : null;
    // Every (element, attribute) our own pre-decide pass writes. Collected only
    // when an inline script actually ran, so the normal path allocates nothing.
    const confirmed: Array<[Element, string]> = [];
    if (snap) {
      activePersona = { persona: snap.persona, band: snap.band };
      activeSlots = snap.slots;
      if (snap.slotConfig) activeSlotConfig = snap.slotConfig;
      // Palette BEFORE the pre-paint apply: cached block arms must render in
      // the site's colors from the first paint, not flip from neutral.
      if (snap.palette) setBlockPalette(snap.palette);
      if (snap.vocabulary) setBlockVocabulary(snap.vocabulary);
      // Pre-paint applies only reversible attributes (persona/arm/dims) from the
      // cached snapshot. Copy/ops are withheld until /v1/decide confirms them —
      // a stale snapshot must never flash wrong content that a decide timeout
      // would leave stuck on screen.
      applyAll(document, {
        contentAndOps: false,
        ...(prePaint ? { onAttr: (el: Element, attr: string) => confirmed.push([el, attr]) } : {}),
      });
      // The cached section order, by contrast, IS applied pre-paint: a late
      // reorder is exactly the flash to avoid, and the bounded apply re-verifies
      // against the CURRENT DOM (a stale/foreign order applies nothing). The
      // post-decide apply below then corrects any drift authoritatively. It is
      // also idempotent, so an order the inline script already applied plans no
      // moves at all.
      if (snap.layoutOrder) {
        activeLayoutOrder = snap.layoutOrder;
        applyLayoutOrder(activeLayoutOrder, document);
      }
    }
    // Revert anything the inline script stamped that the pass above did NOT
    // re-apply. It runs mid-parse and cannot verify a registry locator's
    // fingerprint before the element's children exist, so it can stamp an
    // element we would not. With no snapshot at all the confirmed set is empty
    // and everything it did is undone — which is the right answer, because our
    // authority then says nothing should be applied.
    if (prePaint) reconcilePrePaint(prePaint, confirmed, document);

    const client = init({
      apiKey: cfg.apiKey,
      consent: cfg.consent,
      preConsentBehavior: cfg.preConsentBehavior,
      debug: cfg.debug,
      // Declared persona rides core's session upsert + decide bodies.
      persona: cfg.persona,
      ingestUrl: ingestUrlFrom(cfg),
      ...(SDK_IDENT ? { sdk: SDK_IDENT } : {}),
    });
    activeClient = client;
    clientGen = forgetGeneration(cfg.apiKey);
    exposeGlobal(cfg);
    installSpaHooks();

    const slots = Object.entries(cfg.slots).map(([id, s]) => ({ id, dims: s.dims }));
    // Report our own build version so the server can flag version skew (e.g. a
    // customer's embedded snippet predating reorder-move-op support) — see
    // apps/api decide route + the dashboard Slots editor hint.
    // Only report a real, released version. The dev sentinel ('0.0.0-dev', used
    // in non-tsup builds) passes the server's semver check and would be persisted
    // as the project's snippet_version, permanently reading as "behind" (audit M12).
    const reportVersion = REPORT_V;
    // Which inline pre-paint contract this install carries: its version, or 0 for
    // "the two-tag install, no inline script". Rides the same version-skew report
    // so the dashboard's install-health surface can nudge sites that pasted the
    // config + loader and skipped the middle tag. No serving behaviour depends
    // on it. A record with a HIGHER v than we know reports its own number
    // verbatim rather than being clamped here — the server owns which versions
    // it will store, so a bundle that predates a future contract does not have
    // to be redeployed for that contract to be reportable.
    const reportPrePaint = { pp: prePaint ? prePaint.v : 0 };
    // Configured sections that resolve on THIS page right now (missing ones are
    // dropped, not errored — the request describes what can actually move).
    // Fewer than two left → nothing to reorder, so the field is omitted and the
    // server's layout machinery never engages.
    // Registry ids this page view decides — only components whose element is
    // on the page (see registryLocators). Resolution waits for DOMContentLoaded
    // on async/GTM installs: resolving mid-parse would miss not-yet-parsed
    // elements, silently dropping their trials and reporting false misses.
    // A failed/timed-out locators fetch decides NOTHING (`[]`), never an
    // unscoped decide: the visitor sees the original page and no phantom trial
    // is written, while goals and the section map still bootstrap.
    let registryIds: string[] = [];
    if (locatorsPromise) {
      const [list] = await Promise.all([
        withTimeout(locatorsPromise, DECIDE_TIMEOUT_MS),
        document.readyState === 'loading'
          ? new Promise((res) => document.addEventListener('DOMContentLoaded', res, { once: true }))
          : null,
      ]);
      registryLocators = list;
      // Misses are NOT reported here: hydrating frameworks render after
      // DOMContentLoaded, so they are classified when the post-decide watch
      // window ends (watchRoute), not from this first look.
      if (list) decidedIds = registryIds = scanLocators(list, document)[0];
      dbg(cfg, 'registry scope', list && registryIds);
    }
    const sendDecide = (via: SentientClient = client): Promise<DecideOutcome | null> => {
      const sectionIds = Array.from(resolveSections(document).keys());
      return via.decide({
        slots,
        ...reportVersion,
        ...reportPrePaint,
        ...(sectionIds.length >= 2 ? { sections: sectionIds } : {}),
        ...(registryMode ? { slotsFrom: 'registry' as const, registrySlotIds: registryIds, render: renderFor(registryIds, document) } : {}),
      });
    };
    // Where the decide was asked: core drops a held (consent-pending) decide
    // when the visitor has navigated since, and only THAT null warrants a
    // fresh decide below — a failed one on the same page must not be re-sent
    // (the server may already have booked it; grader F6).
    let decidePath = routeKey();
    // Held (consent pending) at send time: a null answer then means core
    // DROPPED it because the page changed — anything else is a real failure
    // of a decide the server may have booked, which is never re-sent (#5).
    const heldAtSend = client.gated === true;
    // Re-decide only once the first decide has SETTLED with no answer ever
    // received in this run. Arming it earlier (round 4) let any pushState /
    // replaceState during the first decide send a second one whose answer
    // could never apply, and a deferred apply (async install while the
    // document is loading) re-entered it in a loop (grader F1).
    let settled = false;
    // Set when an answer is APPLIED (applyOutcome), not merely received: an
    // answer discarded after a pause→grant must leave the visit decidable
    // (grader SN-1).
    let answered = false;
    // A decide that never reached the page: dropped by core (page changed
    // before consent) or discarded (client swapped mid-flight). Only these
    // are re-sent on a grant; a decide that simply FAILED is retried by the
    // next navigation only — repeated grantConsent() calls used to re-send it
    // each time (review #2).
    let retryable = false;
    let redeciding = false;
    redecide = (nav = false) => {
      const via = activeClient; // the CURRENT client: a re-grant re-inits (F5)
      if (!settled || answered || redeciding || decided || consentRevoked || !via || via.gated) return;
      if (!nav && !retryable) return;
      retryable = false;
      redeciding = true;
      decidePath = routePath = routeKey();
      if (registryLocators) decidedIds = registryIds = scanLocators(registryLocators, document)[0];
      sendDecide(via)
        .then((fresh) => {
          redeciding = false;
          if (fresh && !decided && !consentRevoked && activeClient === via) applyOutcome(fresh);
          else {
            if (!fresh) decidedIds = [];
            // Never shown (client swapped or released, consent revoked):
            // the same rule as the first decide — the next grant re-sends.
            // Without it a pause during a re-decide left the page undecided
            // for the rest of the view (review R8 #5).
            if (!decided && (via.released || activeClient !== via || consentRevoked)) retryable = true;
          }
        })
        .catch(() => void (redeciding = false));
    };
    const decidePromise = sendDecide();
    // Registered before any other handler, so every later one sees the flags.
    decidePromise.then(
      () => {
        settled = true;
      },
      () => void (settled = true),
    );
    const outcome = await withTimeout(decidePromise, DECIDE_TIMEOUT_MS);
    // Everything downstream of a successful decide, extracted so the late-
    // arrival path below can run it too. Synchronous except for applyDecided's
    // own DOMContentLoaded deferral.
    const applyOutcome = (outcome: DecideOutcome): void => {
      answered = true;
      const persona = (activeClient ?? client).getPersona();
      if (persona) activePersona = { persona: persona.persona, band: persona.band };
      else if (outcome.persona) activePersona = { persona: outcome.persona, band: 'low' };
      activeSlots = outcome.slots;
      // Registry mode: adopt the served slotConfig UNCONDITIONALLY (null when
      // absent) so a decide response with no slotConfig CLEARS the cached one —
      // otherwise an unpublished/removed registry slot from the prior visit's
      // snapshot keeps being re-applied and re-persisted (audit). Scoped to the
      // ids this page decided, which also drops snapshot entries for components
      // not on this page. Declared-slot mode carries no server slotConfig, so
      // only overwrite when present.
      if (registryMode) activeSlotConfig = pickConfig(outcome.slotConfig, registryIds);
      else if (outcome.slotConfig) activeSlotConfig = outcome.slotConfig;
      // Served palette wins over the snapshot's; an absent one leaves the cached
      // palette standing for this view (same one-visit-drift rule as layoutOrder
      // — the snapshot write below persists only what the server said).
      if (outcome.palette) setBlockPalette(outcome.palette);
      if (outcome.vocabulary) setBlockVocabulary(outcome.vocabulary);
      // Authoritative section order for this visit — corrects a pre-paint from a
      // stale snapshot (bounded apply is idempotent, so agreeing orders no-op).
      // An absent/empty layoutOrder deliberately leaves the pre-paint order
      // standing for this view, same as a decide timeout would; the snapshot
      // write below persists the server's answer, so it lasts one visit at most.
      activeLayoutOrder = outcome.layoutOrder ?? activeLayoutOrder;
      // Post-decide apply is authoritative — report any locator misses (not from
      // pre-paint or reapply, which would be noisy/premature). Collect the applied
      // (slot, arm, element) triples for per-option behavior signals.
      // Registry mode hands miss classification to the route watch that
      // syncRoute() starts right after this (bounded window, then one report):
      // every id decided here resolved at scan time, so an apply-time absence
      // is a hydration swap in flight, and reporting it here AND from the
      // watch's window end booked the same absence twice — halving the 10-in-
      // 24h auto-suspension threshold for exactly the sites that re-render.
      const applyDecided = (): void => {
        const appliedSlots: AppliedSlot[] = [];
        const applyMissed = applyAll(document, {
          onApplied: (slotId, arm, el) => appliedSlots.push({ slotId, arm, el }),
        });
        if (!registryMode) reportLocatorMisses(cfg, applyMissed);
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
      // Consent may arrive after boot (every consentFrom install boots gated
      // while the presets chunk loads): gating on the boot-time cfg.consent
      // alone left editor goals unwired for the whole visit (grader N-A).
      if ((cfg.consent !== false || consentGranted) && !consentRevoked) wireGoals(outcome.goals, activeClient);

      // Server-classified section map (persona-coverage) → capture typing hook.
      // Stored at module scope (route-scoped) so an SPA navigation can re-derive the
      // typeOf hook for the new path when capture restarts. Resolution reuses the
      // slot locator machinery inside startSectionCapture (resolveLocatorOne: id →
      // data-attr → selector, must be unique, fingerprint must match — never
      // guesses). Explicit data-sentient-type markup still wins inside capture —
      // the no-code path has no provider to declare sectionTypes on.
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
      if (mayWrite(cfg.apiKey)) writeSnapshot(cfg.apiKey, lastSnap = {
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
        // The site styles the served Redesign arms borrow, so the next visit's
        // pre-paint already renders them native.
        ...(outcome.vocabulary ? { vocabulary: outcome.vocabulary } : {}),
      });
      // Start this page's late-render watch and deferred miss classification —
      // on whatever path we are on NOW, so a navigation that landed while decide
      // was in flight (skipped by syncRoute: `decided` was false) is caught up.
      routePath = null;
      syncRoute();
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
          // Consent granted after an SPA navigation: core drops the held
          // decide (its slots may be gone) and it resolves null. Decide the
          // CURRENT route instead — without this `decided` stayed false, so no
          // later route was ever decided either and the visit ran on baseline
          // (grader N-C). Registry mode only: its route watch decides exactly
          // what resolves on this page.
          if (!late) {
            if (decided) return;
            decidedIds = [];
            // Never shown: core dropped the held decide (page changed), the
            // gated client was released (refusal/revoke — it resolves null
            // without sending), or the client was swapped (pause, re-grant).
            // Those re-decide on the next grant — redecide itself waits for a
            // tracking client. A decide that FAILED stays failed; the next
            // navigation retries it (F6/#5, R6-SN-1, N7-4).
            if (client.released === true || activeClient !== client || consentRevoked || (heldAtSend && routeKey() !== decidePath)) {
              retryable = true;
              redecide?.();
            } else routePath = decidePath;
            return;
          }
          if (!late || decided || consentRevoked) return;
          if (activeClient !== client) {
            // Discarded (client swapped): the next grant may decide again.
            retryable = true;
            redecide?.();
            return;
          }
          applyOutcome(late);
          dbg(cfg, 'late decide applied', matchCounts(cfg));
        })
        .catch(() => undefined);
      return; // for THIS paint the snapshot state (or bare page) stands
    }
    // A client swap while it was in flight (revoke → grant): a forgotten
    // visitor's decision must not be applied or written back (review #3).
    if (consentRevoked || activeClient !== client) {
      // Discarded, not failed: re-decide with the current client (now, if it
      // is already tracking again; else on the next grant) — the answer was
      // booked, and the sticky server row serves the same arm (N7-2).
      retryable = true;
      redecide?.();
      return;
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
    // Deferred one microtask: run()'s visitor path is synchronous all the way
    // through exposeGlobal(), so calling it inline ran it during the module
    // body — and tsup's IIFE footer then assigned the module exports over
    // window.SentientSnippet, clobbering the runtime API (goal(), getState())
    // with an object that has neither. A microtask runs after the whole
    // script statement (footer assignment included), so exposeGlobal wins —
    // still same-tick and pre-paint, so the snapshot flash guard is unchanged.
    // Promise.resolve().then, NOT queueMicrotask: that API is missing on the
    // iOS 12-era engines this bundle still serves (see css-guard's matchAll
    // note / audit SNIP-5), and a ReferenceError here would leave the whole
    // snippet inert — worse than the clobber this defers around.
    Promise.resolve().then(() => void run());
  } else {
    // A second embed of the bundle (GTM plus a hard-coded tag) doesn't run
    // again, but its IIFE footer still assigned build-time exports over the
    // live API: goal() vanished and the README stub's forwarding queued into
    // a dead array for the rest of the page (review R11 #3). Put it back,
    // after that footer — same microtask trick as above.
    const live = (window as unknown as { __sentientApi?: unknown }).__sentientApi;
    if (live) Promise.resolve().then(() => void ((window as unknown as { SentientSnippet?: unknown }).SentientSnippet = live));
  }
}
