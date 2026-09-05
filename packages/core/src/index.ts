import { initSession, type SessionConfig, type SessionManager } from './session';
import {
  createEventQueue,
  retryStorageKey,
  type EventQueue,
  type EventType,
  type QueueConfig,
  type SentientEvent,
} from './queue';
import {
  createGoalQueue,
  goalRetryStorageKey,
  type GoalQueue,
} from './goal-queue';
import {
  createAssignmentCache,
  type Assignment,
} from './cache';
import type {
  GraphConfig,
  GraphSnapshot,
} from './graph';
import {
  detectDeviceClass,
  detectTrafficSource,
  detectTimeOfDay,
  extractTrackedParams,
  referrerDomainFromReferer,
  uaTokenMatch,
} from './session-meta.js';
import {
  toWireSlot,
  baselineResultFor,
  armOfResult,
  type SlotDeclInput,
  type SlotResult,
} from './slots.js';
import { readSnapshot, writeSnapshot, SNAPSHOT_STORAGE_KEY_PREFIX, type SlotConfigEntry, type CompoundLocator } from './snapshot.js';
import { confidenceBand } from '@sentientui/policy';
import { createLocalModeClient } from './local-mode.js';
import { randomUuidV4 } from './uuid.js';
import { backoffDelayMs, classifyResponse } from './durable.js';

export { PROD_KEYLESS_ERROR, LOCAL_MODE_BANNER } from './local-mode.js';

// The one source of truth for the session cookie's name — every out-of-package
// reader (react devtools, integrator SSR code) must derive the name from this
// instead of hard-coding `_snt_uid`, which is only the pre-namespacing fallback.
export { sessionCookieName, LEGACY_SESSION_COOKIE_NAME } from './storage-key.js';

export {
  detectDeviceClass,
  detectTrafficSource,
  detectTimeOfDay,
  deriveSessionSegment,
  extractTrackedParams,
  CLICK_ID_KEYS,
  referrerDomainFromReferer,
  uaTokenMatch,
  matchedAgentToken,
  agentUaList,
  agentIntent,
  classifiedAgents,
  AGENT_INTENTS,
} from './session-meta.js';
export type { AgentIntent } from './session-meta.js';

const DEFAULT_INGEST_URL = 'https://api.sentient-ui.com/v1/events';

// Keyed by apiKey so multiple init() calls (HMR, multi-project) don't collide.
const _clients = new Map<string, {
  config: SentientConfig;
  upgrade: ((c: SentientClient) => void) | null;
  // Why grantConsent() cannot upgrade this entry (keyless/local mode, invalid
  // key). grantConsent() warns with this instead of silently no-oping — a CMP
  // callback wired to it otherwise LOOKED like it worked while nothing ever
  // started tracking. Absent for entries where the silent no-op IS the
  // documented contract (DNT-blocked, already upgraded).
  upgradeBlockedReason?: string;
  // Set by an alternate entry point (the /graph entry) whose gated init
  // deferred extra resources: grantConsent() must re-run THAT entry's init —
  // upgrading through the lean init() produced a post-consent client that
  // never mounted the DOM scanner, silently losing graph capture.
  reinit?: (c: SentientConfig) => SentientClient;
  // Teardown for the live client bound to this key (stops its queue interval +
  // unload listeners). Present only for the full tracking client; the no-op /
  // pre-consent / local entries have nothing to tear down. Called before a
  // re-init for the same key replaces it, so timers/listeners can't leak.
  dispose?: () => void;
}>();
let _lastApiKey: string | null = null;

/**
 * @internal Wires an alternate entry point's init as grantConsent()'s upgrade
 * path for `apiKey`. The /graph entry calls this when its init is gated on
 * consent: without it, grantConsent() upgraded through the LEAN init, so a
 * graph-configured page granted consent but never mounted the scanner (the
 * graph resources exist only in the /graph entry). No-op unless the entry is
 * actually upgradeable — DNT-blocked and local entries register no hook.
 */
export function _registerConsentUpgradeInit(
  apiKey: string,
  reinit: (config: SentientConfig) => SentientClient,
): void {
  const entry = _clients.get(apiKey);
  if (entry && entry.upgrade) entry.reinit = reinit;
}

export type SentientConfig = {
  apiKey: string;
  context: 'landing' | 'ecommerce' | 'saas' | 'marketplace';
  /** @internal — not exposed to users; defaults to the hosted SentientUI API. */
  ingestUrl?: string;
  debug?: boolean;
  /**
   * Pre-seeded assignments from `preloadAssignments()` (SSR).
   * Seeds the local cache so `assign()` returns without a network call for
   * listed code variants, guaranteeing server and client render the same
   * variant on first paint. Managed-text components (assign with no
   * variantIds) still fetch once when the seed carries no content.
   */
  initialAssignments?: Record<string, string>;
  /**
   * Segment used for SSR preload (`device:source`). When set with `initialAssignments`,
   * seeds the assignment cache under this key so hydration matches the server bandit row.
   */
  sessionSegment?: string;
  /**
   * Consent gate. When `false`, returns a no-op client and performs no tracking.
   * Defaults to `true`. Re-call `init()` (via `AdaptiveProvider` consent prop) when
   * the user grants or revokes consent mid-session.
   */
  consent?: boolean;
  /**
   * Behavior before consent is granted. `'statistical_winner'` fetches the
   * best-performing variant via `GET /v1/winner` — no session or tracking data
   * is stored. `'control'` (default) shows `variantIds[0]` with no API call.
   * Applies when tracking is gated off — either `consent: false` or an active
   * Do Not Track signal.
   */
  preConsentBehavior?: 'statistical_winner' | 'control';
  /**
   * Whether to honor the browser's Do Not Track (DNT) signal. Defaults to `true`.
   * When `true` and the visitor has DNT enabled, the SDK sets no cookies and
   * sends no tracking data — behaving exactly as `consent: false` (still serving
   * the read-only `preConsentBehavior` winner if configured), and `grantConsent()`
   * will not upgrade it. Set `false` to make your own consent gate authoritative.
   */
  respectDoNotTrack?: boolean;
  userId?: string;
  /**
   * Declared persona — the role your app already knows for this visitor
   * (e.g. 'admin', 'evaluator'). Must be a key in the project's persona
   * vocabulary (dashboard → Settings → Personas); unrecognized values are
   * ignored server-side and surfaced in the dashboard so you can add them.
   * Declared personas are served at full confidence, overriding the inferred
   * one. Keep it a low-cardinality role label — never a user id or email.
   */
  persona?: string;
  /**
   * Session ID generated server-side (from `loadAdaptiveAssignments` / `loadAdaptiveDecision`).
   * When provided, the client adopts this ID on first visit instead of generating a new one,
   * ensuring events and goals are attributed to the same session the server used for assignment.
   */
  ssrSessionId?: string;
  /**
   * ISO 3166-1 alpha-2 country code for the visitor. When provided (e.g. from
   * the `CF-IPCountry` header in a Next.js server component), it is included in
   * the session upsert so country-based segmentation works without client-side
   * geo lookup.
   */
  country?: string;
  /**
   * Pre-seeded slot results from `preloadDecisions()` / `loadAdaptiveDecision()`
   * (SSR). Seeds the local slot state so `getSlotResult()` agrees with the
   * server-rendered markup on first paint.
   */
  initialSlots?: Record<string, SlotResult>;
  /**
   * Persona decided during SSR. Takes priority over the html-attribute
   * adoption and the local snapshot.
   */
  initialPersona?: { persona: string; confidence: number };
  /**
   * Keyless local mode. 'auto' (default) simulates decisions on-device when no
   * valid API key is configured — but only in development builds (the
   * `development` export condition); production bundles physically exclude the
   * engine. `true` forces the local engine regardless of key (escape hatch);
   * `false` restores the silent keyless no-op.
   */
  localMode?: 'auto' | boolean;
};

export type AssignResult = { variantId: string; assignmentTtlMs: number; content?: string };

export type { SlotDeclInput, SlotResult };
export { armOfResult, baselineResultFor, baselineSlots, toWireSlot } from './slots.js';

export {
  SNAPSHOT_STORAGE_KEY_PREFIX,
  readSnapshot,
  writeSnapshot,
  renderPrePaintScript,
} from './snapshot.js';
export type { DecisionSnapshot, SlotConfigEntry, SlotOps, CompoundLocator } from './snapshot.js';
export * from './blocks.js';

/** An editor-defined goal delivered with a registry-mode decision, for the
 *  snippet to install delegated listeners from. */
export type GoalDefinition = {
  goalId: string;
  event: 'click' | 'form_submit' | 'url_reached' | 'scroll_depth';
  locator?: CompoundLocator;
  urlPattern?: string;
  slotId?: string;
  /** scroll_depth only: fraction of the page (0–1] that counts as read. */
  threshold?: number;
};

/** One served section-classification row (registry mode): where it is on the
 *  page (url match + compound locator) and its semantic type. The snippet
 *  resolves the locator to build capture's `typeOf` hook. */
export type SectionMapEntry = {
  urlMatch: string;
  locator: CompoundLocator;
  type: string;
};

export type DecideOutcome = {
  layoutOrder: string[] | null;
  assignments: Record<string, string>;
  slots: Record<string, SlotResult>;
  persona: string;
  confidence: number;
  // Registry mode only: where/what to apply for server-defined slots.
  slotConfig?: Record<string, SlotConfigEntry>;
  // Registry mode only: editor-defined goals to wire up.
  goals?: GoalDefinition[];
  // Registry mode only: served section-classification map the snippet turns
  // into capture's `typeOf` hook.
  sectionMap?: SectionMapEntry[];
  // Registry mode only: derived site palette for Composition Block rendering.
  palette?: import('./blocks.js').SitePalette;
};

export type DecideInput = {
  sections?: string[];
  components?: Array<{ id: string; variantIds?: string[] }>;
  slots?: SlotDeclInput[];
  // 'registry' → serve the project's published slot_definitions in addition to
  // any declared slots (registry wins on id collision). Default 'request'.
  slotsFrom?: 'request' | 'registry';
  /**
   * Caller's build version (e.g. the snippet's `__SNIPPET_VERSION__`), sent
   * as `v` on the wire. Additive/best-effort: the server persists it for
   * version-skew reporting (see apps/api decide route) and ignores it
   * entirely on older deployments. Omit if the caller has no version to report.
   */
  v?: string;
};

export type WeightEntry = { variantId: string; pulls: number; avgReward: number | null };
export type ComponentWeightEntry = { componentId: string; updatedAt: number; variants: WeightEntry[] };

/** Options accepted by goal() (and inherited by componentGoal / the React
 *  hooks / the snippet) — one shape everywhere (spec §5). */
export type GoalOptions = {
  /** Revenue of this conversion, in the project currency. */
  value?: number;
  /** ISO-4217 code, only when it differs from the project currency. */
  currency?: string;
  /** Merchant order/transaction id — dedupes retries, enables refunds later. */
  externalId?: string;
  /** Extra fields merged into the event payload / goal metadata. */
  metadata?: Record<string, unknown>;
  /** Advanced: partial-credit weight in [0,1] (composite steps). */
  weight?: number;
  /** Advanced: funnel step index (0-based). */
  stepIndex?: number;
};

/** goal()'s second arg is the options object iff it carries a reserved key;
 *  anything else keeps the legacy bare-metadata interpretation. Reserved keys
 *  inside legacy metadata were inert on the server, so reinterpretation is the
 *  upgrade the sender wanted (spec §5). */
function isGoalOptions(v: Record<string, unknown>): boolean {
  return 'value' in v || 'currency' in v || 'externalId' in v || 'metadata' in v || 'weight' in v || 'stepIndex' in v;
}

export type ComponentGoalOptions = GoalOptions & {
  /** Reward credited to the served variant (0–1). Defaults to 1. */
  reward?: number;
};

export type SentientClient = {
  track(
    event: Omit<SentientEvent, 'id' | 'sessionId' | 'timestamp' | 'timeInSession'>,
  ): void;
  goal(name: string, options?: GoalOptions): void;
  /** @deprecated positional form — prefer goal(name, options). */
  goal(name: string, metadata?: Record<string, unknown>, weight?: number, stepIndex?: number): void;
  /**
   * Records a conversion attributed to the variant currently served for
   * `componentId`, so it feeds the per-variant CVR funnel. Resolves the served
   * variant from the local assignment cache — no need to pass variantId or
   * projectId. No-ops if the component has not been assigned yet (render its
   * `<Adaptive>`/call `assign()` first). Prefer this over bare `goal()` for
   * variant experiments; `goal()` is session-level only (no component attribution).
   */
  componentGoal(componentId: string, goalType: string, opts?: ComponentGoalOptions): void;
  identify(userId: string): void;
  getAssignment(componentId: string, segment: string): Assignment | null;
  /** Server-side variant assignment. Caches the result locally per (component, segment). */
  assign(componentId: string, variantIds?: string[], agentData?: unknown, agentDataByVariant?: Record<string, unknown>): Promise<AssignResult | null>;
  /**
   * Single-roundtrip decision for layout sections, component variants, and
   * adaptive slots. Awaits the session upsert (like `assign`) so the server
   * never decides for a session row that doesn't exist yet. A response
   * without a `slots` field means the server predates slots — every declared
   * slot resolves to its baseline and no retry is made.
   */
  decide(input: DecideInput): Promise<DecideOutcome | null>;
  /** Slot result served this session (decide result, SSR seed, snapshot, or failure baseline). Null when unknown. */
  getSlotResult(slotId: string): SlotResult | null;
  /** Current persona estimate. Band is always `confidenceBand(confidence)`. Null when nothing is known yet. */
  getPersona(): { persona: string; confidence: number; band: 'low' | 'medium' | 'high' } | null;
  /** Fetches current bandit weights for all components in this project. Used by the provider to keep live-weight polling fresh. */
  fetchWeights(): Promise<ComponentWeightEntry[]>;
  getGraph(): GraphSnapshot;
  /**
   * Routine teardown: stops timers/listeners and flushes pending events, but
   * KEEPS the visitor identity, decision snapshot, and retry bucket. Use for
   * component unmount / re-init (framework providers call this on cleanup).
   */
  dispose(): void;
  /**
   * Consent-revocation / forget-me teardown: everything `dispose()` does,
   * plus deletion of the visitor identity (`_snt_uid`), the decision
   * snapshot, and the persisted retry bucket. The next visit starts as a
   * brand-new visitor.
   */
  destroy(): void;
  /** True when this client is the keyless local-mode client (dev only). */
  readonly isLocal?: boolean;
};

// SSR preload helpers moved to the `@sentientui/core/server` entry in 0.6.0 so
// ~200 lines of Node-only fetch logic stop shipping in the browser bundle.

export { attachMicroSignalDetectors } from './micro-signals.js';
export type { MicroSignalEmitter, MicroSignalType } from './micro-signals.js';

export type {
  SessionConfig,
  SessionManager,
  EventType,
  SentientEvent,
  QueueConfig,
  Assignment,
  GraphSnapshot,
  GraphConfig,
};

/** Attempts after the first for the session upsert — see upsertSession. */
const SESSION_UPSERT_RETRIES = 3;

function generateEventId(): string {
  return randomUuidV4();
}

/**
 * The page an event happened on.
 *
 * `location.pathname` ONLY — never `href` or `search`. Query strings on real
 * sites carry emails, reset tokens, order ids and session ids, and none of that
 * should leave the browser for analytics. The server strips them again
 * (domain/page-path.ts) because a hand-rolled integration can post whatever it
 * likes; this is the first of the two gates, and the one that means the data
 * never travels at all.
 *
 * Undefined outside a browser: during SSR there is no page to name, and an
 * invented one would be wrong for every reader.
 */
function currentPath(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.location?.pathname || undefined;
}

/**
 * Decides whether a goal() call belongs to a user action already recorded.
 *
 * This used to be a clock: a latch cleared on the next macrotask, so anything
 * inside that window counted as "the same action". A clock cannot tell the two
 * cases apart, and it got the expensive one wrong. The window can be JUMPED —
 * a macrotask scheduled to close it runs after any timer already armed, which
 * every real page and every sibling test in a worker has — so a genuinely
 * separate conversion landed in a window that should have shut, and was
 * swallowed rather than queued: gone, with no retry able to rescue it because
 * nothing was ever handed to the queue.
 *
 * So ask the question the clock was approximating. Two nested components
 * reacting to one click are, exactly, two listeners in one event DISPATCH, and
 * the platform already hands us that identity: `window.event` is the same Event
 * object for every listener of one dispatch, a different object for the next
 * click, and undefined outside dispatch entirely. Keying on the event object
 * makes "one action" a fact rather than a deadline — no timer to lose a race
 * with, no fake-timer or background-throttle hazard, and no way for a second
 * click to be mistaken for the first however long the page stalls between them.
 *
 * Goals fired outside any dispatch (an effect on mount, a page goal) have no
 * event to key on, and fall back to one SYNCHRONOUS flush — closed on a
 * microtask. That is exact too, and for the same reason the old macrotask
 * window was not: microtasks always drain before the next macrotask, so no
 * pending timer can jump this window. A user cannot perform two actions inside
 * one synchronous block, so anything sharing it is a double-fire, not a repeat.
 *
 * A microtask is deliberately NOT used for the dispatch case: the HTML spec
 * runs a microtask checkpoint between listeners once the JS stack empties, so
 * it would split one click into two and double-count the revenue this collapse
 * exists to protect. That is why the dispatch case keys on the event instead,
 * and why a host without `window.event` keeps the old macrotask window — too
 * loose, but erring toward the old behaviour rather than toward double-counting.
 */
function createActionLatch(): { firedBefore(actionKey: string, valueKey: string | null): boolean } {
  // Per window, per action key: the set of value identities already recorded.
  // An entry with an empty set means a VALUELESS fire was recorded. The split
  // exists because value cannot simply live inside one flat key: an inner
  // component declaring `value: 50` nested in an outer wrapper with the same
  // goal but NO value produced two distinct keys — two rows for one click.
  // Within a window, a valueless fire is absorbed by ANY record of the same
  // action (the valued row already carries the order, and a valueless
  // duplicate would inflate Hits), while a valued fire is collapsed only by an
  // IDENTICAL (value, currency) record — $50 and $70 stay two orders
  // (CONTRACTS §1). A valued fire landing AFTER a valueless one still records:
  // the valueless row has already been handed to the queue (often already on
  // the wire) and cannot be retracted, and losing the money would be the worse
  // error — server-side credit clamps the extra valueless hit at min(1, MAX
  // weight), so the cost is one inflated Hit, not corrupted revenue. Listener
  // order makes the benign ordering the common one: the inner (valued)
  // component's listener runs before the wrapper's in a bubbling dispatch.
  const byEvent = new WeakMap<object, Map<string, Set<string>>>();
  const byFlush = new Map<string, Set<string>>();
  let flushOpen = false;

  const alreadyRecorded = (map: Map<string, Set<string>>, actionKey: string, valueKey: string | null): boolean => {
    const values = map.get(actionKey);
    if (valueKey === null) {
      if (values) return true;
      map.set(actionKey, new Set());
      return false;
    }
    if (!values) {
      map.set(actionKey, new Set([valueKey]));
      return false;
    }
    if (values.has(valueKey)) return true;
    values.add(valueKey);
    return false;
  };

  // Standardised as Window.event and present in every current browser, but a
  // capability check keeps exotic hosts on the path they have always had.
  const hasWindowEvent = typeof window !== 'undefined' && 'event' in window;

  const currentEvent = (): object | undefined => {
    if (!hasWindowEvent) return undefined;
    const ev = (window as unknown as { event?: unknown }).event;
    // Must be a real same-realm Event, not merely an object. Window.event is
    // [Replaceable]: a classic script doing `event = {...}` at top level (an
    // implicit or sloppy global on plenty of host pages) permanently shadows
    // the accessor with a data property. Accepting any object then returned
    // that SAME object forever — its WeakMap entry never died, so every later
    // conversion looked like a re-fire of the first action and ALL repeat
    // conversions were silently dropped for the session. `instanceof Event`
    // cannot be true for such a literal; a cross-realm Event (iframe) fails it
    // too and merely falls back to the flush window, which is safe.
    // (typeof guard: a host with `window` but no Event constructor must fall
    // back, not throw a ReferenceError from inside goal().)
    return typeof Event === 'function' && ev instanceof Event ? ev : undefined;
  };

  const closeFlushWindow = (): void => {
    if (hasWindowEvent) {
      // A promise microtask, not queueMicrotask: fake-timer setups can replace
      // queueMicrotask, and this window closing is what keeps repeat
      // conversions from being swallowed.
      void Promise.resolve().then(() => {
        flushOpen = false;
        byFlush.clear();
      });
      return;
    }
    let done = false;
    const clear = (): void => {
      if (done) return;
      done = true;
      flushOpen = false;
      byFlush.clear();
    };
    setTimeout(clear, 0);
    if (typeof MessageChannel === 'function') {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        ch.port2.close();
        clear();
      };
      ch.port2.postMessage(0);
    }
  };

  return {
    firedBefore(actionKey: string, valueKey: string | null): boolean {
      const ev = currentEvent();
      if (ev) {
        let keys = byEvent.get(ev);
        if (!keys) {
          keys = new Map<string, Set<string>>();
          // Keyed weakly: the Map dies with the Event object, so a long session
          // of clicks accumulates nothing.
          byEvent.set(ev, keys);
        }
        return alreadyRecorded(keys, actionKey, valueKey);
      }
      const collapsed = alreadyRecorded(byFlush, actionKey, valueKey);
      if (!collapsed && !flushOpen) {
        flushOpen = true;
        closeFlushWindow();
      }
      return collapsed;
    },
  };
}

/**
 * Emits one `pageview` per page load and per SPA route change.
 *
 * Patches pushState/replaceState rather than polling: a route change is a
 * discrete event, and polling would either miss fast back-to-back navigations or
 * burn a timer on every page for the entire session. popstate covers
 * back/forward, which history patching does not see.
 *
 * Deduplicates on pathname, because frameworks routinely replaceState several
 * times for one navigation (query/hash updates, scroll restoration) and each
 * would otherwise look like another page in the visitor's journey.
 */
/** Pages already recorded this page lifetime, keyed project:path. dispose()
 *  flushes, so without this a consent-change or StrictMode re-init delivered a
 *  second landing pageview for a page the previous client already sent. */
const emittedPages = new Set<string>();

function startPageviewTracking(
  client: SentientClient,
  projectId: string,
  // Called with the page key after emitting; the caller marks emittedPages only
  // once the event reached a LIVE queue. Marking at emit time instead turned
  // StrictMode's mount→dispose→mount into zero delivered landings: the first
  // mount's event dies in the destroyed queue, and the mark suppressed the
  // second mount's — the one that actually ships.
  markDelivered: (key: string) => void,
): () => void {
  const h = typeof window === 'undefined' ? null : window.history;
  if (!h) return () => undefined;

  // The stop handle exists because init() runs again on every consent change,
  // StrictMode double-invoke and HMR: without it each init wrapped history
  // again and the old wrapper kept emitting through the DISPOSED client, so one
  // navigation produced one pageview per init that ever happened.
  let stopped = false;
  let last: string | undefined;
  const emit = (): void => {
    if (stopped) return;
    const path = currentPath();
    if (!path || path === last) return;
    last = path;
    // '__page__' is a sentinel componentId: the ingest schema requires one, and
    // every component reader filters on variant_id IS NOT NULL or a specific
    // event_type, so it never surfaces as a component.
    client.track({ projectId, componentId: '__page__', eventType: 'pageview', payload: {} });
    markDelivered(`${projectId}:${path}`);
  };

  const installed: Array<['pushState' | 'replaceState', History['pushState'], History['pushState']]> = [];
  for (const name of ['pushState', 'replaceState'] as const) {
    const orig = h[name];
    const wrapper = function (this: History, ...a: unknown[]) {
      const r = (orig as (...x: unknown[]) => unknown).apply(this, a);
      emit();
      return r;
    } as History[typeof name];
    h[name] = wrapper;
    installed.push([name, orig, wrapper]);
  }
  window.addEventListener('popstate', emit);

  // The landing page itself — once per (project, path) per page lifetime. When
  // it was already sent, `last` is still primed so the next real navigation
  // emits exactly once.
  const landing = currentPath();
  if (landing && emittedPages.has(`${projectId}:${landing}`)) last = landing;
  else emit();

  return () => {
    if (stopped) return;
    stopped = true;
    window.removeEventListener('popstate', emit);
    for (const [name, orig, wrapper] of installed) {
      // Restore only while ours is still on top; if something wrapped over it,
      // unhooking would sever their chain — the stopped flag already makes ours
      // a passthrough.
      if (h[name] === wrapper) h[name] = orig;
    }
  };
}

const SSR_CLIENT: SentientClient = {
  track: () => undefined,
  goal: () => undefined,
  componentGoal: () => undefined,
  identify: () => undefined,
  getAssignment: () => null,
  assign: () => Promise.resolve(null),
  decide: () => Promise.resolve(null),
  getSlotResult: () => null,
  getPersona: () => null,
  fetchWeights: () => Promise.resolve([]),
  getGraph: () => ({ pageNodes: [], capturedAt: 0 }),
  dispose: () => undefined,
  destroy: () => undefined,
};

function readTrackedParams(): {
  utmParams: Record<string, string>;
  clickIds: Record<string, string>;
} {
  try {
    return extractTrackedParams(window.location.search);
  } catch {
    return { utmParams: {}, clickIds: {} };
  }
}

function deriveBaseUrl(ingestUrl: string): string {
  return ingestUrl.replace(/\/events\/?$/, '');
}

/**
 * Detects whether the visitor has signalled a tracking opt-out. Honors Global
 * Privacy Control (`navigator.globalPrivacyControl`) — the legally-enforceable
 * CCPA/CPRA signal — as well as Do Not Track (`navigator.doNotTrack`, the legacy
 * `window.doNotTrack` on older Firefox, and `navigator.msDoNotTrack` on old
 * IE/Edge). GPC is a boolean; DNT is opt-out only when explicitly `'1'`/`'yes'`.
 */
export function isDoNotTrackEnabled(): boolean {
  // GPC is a boolean flag, checked separately from the DNT string signals.
  if (
    typeof navigator !== 'undefined' &&
    (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl === true
  ) {
    return true;
  }
  const signals = [
    typeof navigator !== 'undefined' ? navigator.doNotTrack : undefined,
    typeof window !== 'undefined'
      ? (window as unknown as { doNotTrack?: string | null }).doNotTrack
      : undefined,
    typeof navigator !== 'undefined'
      ? (navigator as unknown as { msDoNotTrack?: string | null }).msDoNotTrack
      : undefined,
  ];
  return signals.some((v) => v === '1' || v === 'yes');
}

/**
 * Upgrades a pre-consent client (any client created with `consent: false`, in
 * either `preConsentBehavior` mode) to a fully-tracking client, in place and
 * with no page reload. Call this from your consent management platform callback.
 * For React apps, prefer updating the `consent` prop on `<AdaptiveProvider>`.
 * Pass `apiKey` to target a specific project; omit to upgrade the most-recently-initialized client.
 */
export function grantConsent(apiKey?: string): void {
  if (typeof window === 'undefined') return;

  const key = apiKey ?? _lastApiKey;
  if (!key) {
    console.warn('[sentient] grantConsent() called before init()');
    return;
  }

  const entry = _clients.get(key);
  if (!entry) {
    console.warn('[sentient] grantConsent() called before init()');
    return;
  }

  const { config, upgrade, reinit } = entry;
  if (!upgrade) {
    // Keyless/local and invalid-key clients register no upgrade hook — there
    // is no hosted client to swap in. This used to return SILENTLY, so a CMP
    // callback wired to grantConsent() looked like it worked while nothing
    // ever started tracking. DNT-blocked and already-upgraded entries carry no
    // reason and stay quiet: for them the no-op is the documented contract.
    if (entry.upgradeBlockedReason) console.warn(entry.upgradeBlockedReason);
    return;
  }

  // Honor an active Do Not Track signal — consent cannot override a global opt-out.
  if (config.respectDoNotTrack !== false && isDoNotTrackEnabled()) return;

  // Upgrade through the entry point that ran the gated init when one
  // registered itself (see _registerConsentUpgradeInit) — the lean init knows
  // nothing about that entry's extra resources (the /graph scanner).
  const fullClient = (reinit ?? init)({ ...config, consent: true });
  upgrade(fullClient);
  // init() just registered the full client (with its dispose) under `key`.
  // Preserve that dispose so a later re-init/teardown can still tear it down —
  // we only need to clear the upgrade hook now that consent is granted.
  const disposed = _clients.get(key)?.dispose;
  _clients.set(key, { config: { ...config, consent: true }, upgrade: null, dispose: disposed });
}

function createPreConsentProxy(config: SentientConfig): { proxy: SentientClient; setInner: (c: SentientClient) => void } {
  // 'control' (the default) must reach the network zero times before consent.
  // The proxy still exists so grantConsent() has something to upgrade in place
  // — without it, a site wanting no pre-consent traffic could only start
  // tracking by reloading the page.
  const servesWinner = config.preConsentBehavior === 'statistical_winner';
  const baseUrl = deriveBaseUrl(config.ingestUrl ?? DEFAULT_INGEST_URL);
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  } as const;

  // Pre-consent winners are read-only and render-driven: every mounted
  // component re-calls assign() on every render, and without a result cache or
  // in-flight coalescing each call refired GET /v1/winner — the full client
  // has inflightAssigns for exactly this. Successful winners are cached for
  // the pre-consent phase (the winner is stable, and a flip mid-visit would be
  // a variant flash anyway); failure fallbacks are NOT cached, so a recovering
  // server gets asked again. Both maps die with the proxy on upgrade.
  const winnerCache = new Map<string, AssignResult>();
  const inflightWinners = new Map<string, Promise<AssignResult | null>>();

  let inner: SentientClient = {
    track: () => undefined,
    goal: () => undefined,
    componentGoal: () => undefined,
    identify: () => undefined,
    getAssignment: () => null,
    fetchWeights: () => Promise.resolve([]),
    assign(componentId, variantIds, _agentData?) {
      // Control mode: no request. Callers fall back to variantIds[0] through
      // ssrFallback, exactly as they did against the old no-op client.
      if (!servesWinner) return Promise.resolve(null);
      const cached = winnerCache.get(componentId);
      if (cached) return Promise.resolve(cached);
      return coalesce(inflightWinners, componentId, async (): Promise<AssignResult | null> => {
        try {
          const params = new URLSearchParams({ componentId });
          for (const v of variantIds ?? []) params.append('variantIds[]', v);
          const res = await fetch(`${baseUrl}/winner?${params.toString()}`, {
            headers: authHeaders,
          });
          if (!res.ok) return variantIds?.[0] ? { variantId: variantIds[0], assignmentTtlMs: 0 } : null;
          const body = (await res.json()) as { variantId: string };
          const result: AssignResult = { variantId: body.variantId, assignmentTtlMs: 0 };
          winnerCache.set(componentId, result);
          return result;
        } catch {
          return variantIds?.[0] ? { variantId: variantIds[0], assignmentTtlMs: 0 } : null;
        }
      });
    },
    decide: () => Promise.resolve(null),
    getSlotResult: () => null,
    getPersona: () => null,
    getGraph: () => ({ pageNodes: [], capturedAt: 0 }),
    dispose: () => undefined,
    destroy: () => undefined,
  };

  const proxy: SentientClient = {
    track: (e) => inner.track(e),
    // Cast: a single arrow can't structurally satisfy the overloaded member;
    // the passthrough forwards both call shapes untouched.
    goal: ((n: string, m?: Record<string, unknown>, w?: number, s?: number) => inner.goal(n, m, w, s)) as SentientClient['goal'],
    componentGoal: (c, g, o) => inner.componentGoal(c, g, o),
    identify: (u) => inner.identify(u),
    getAssignment: (c, s) => inner.getAssignment(c, s),
    assign: (c, v, a, av) => inner.assign(c, v, a, av),
    decide: (i) => inner.decide(i),
    getSlotResult: (s) => inner.getSlotResult(s),
    getPersona: () => inner.getPersona(),
    fetchWeights: () => inner.fetchWeights(),
    getGraph: () => inner.getGraph(),
    dispose: () => inner.dispose(),
    destroy: () => inner.destroy(),
  };

  function setInner(fullClient: SentientClient) {
    inner = fullClient;
  }

  return { proxy, setInner };
}

/**
 * Shares one promise among concurrent calls with the same key — assign() and
 * decide() both use this so N same-tick requests (several mounted slots
 * sharing a component id; per-slot lazy decides) cost one roundtrip. The map
 * entry lives exactly as long as the request is in flight: a settled result
 * must NOT serve later calls (a sequential re-request is a fresh decision —
 * caching lives elsewhere), and a failed one must not wedge the key. No
 * `.finally()` — that's ES2018 and this file ships in the es2017 snippet
 * bundle (the SNIP-5 lesson).
 */
function coalesce<T>(inflight: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  const hit = inflight.get(key);
  if (hit) return hit;
  const request = (async (): Promise<T> => {
    try {
      return await run();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, request);
  return request;
}

/**
 * Initializes the Sentient client. Returns a no-op client during SSR.
 */
export function init(config: SentientConfig): SentientClient {
  if (typeof window === 'undefined') {
    return SSR_CLIENT;
  }

  // `|| 'local'`: keyless clients register under the 'local' fallback key
  // below, and `_lastApiKey = ''` is falsy — so a no-arg grantConsent() after
  // a keyless init() warned "called before init()" even though init() DID run,
  // instead of resolving that entry (and its blocked-upgrade explanation).
  _lastApiKey = config.apiKey || 'local';

  // A re-init for the same key (HMR, consent toggle, provider remount) supersedes
  // the prior client. Dispose it first so its queue's setInterval and
  // visibilitychange/pagehide listeners don't leak — the map only ever held its
  // config, so without this the old client kept flushing forever.
  const prevEntry = _clients.get(config.apiKey || 'local');
  if (prevEntry?.dispose) {
    try {
      prevEntry.dispose();
    } catch {
      /* teardown must never throw on re-init */
    }
  }

  // DNT/GPC (a global opt-out) or an explicit `consent: false` must be evaluated
  // BEFORE the local-mode branch: createLocalModeClient() calls initSession()
  // unconditionally, so a gated visitor would otherwise be issued the 365-day
  // `_snt_uid` identity cookie in keyless/local mode (audit P2). DNT/GPC also
  // gates tracking off even when the site passes `consent: true`, and blocks
  // `grantConsent()` from upgrading.
  const dntBlocked = config.respectDoNotTrack !== false && isDoNotTrackEnabled();
  const gated = config.consent === false || dntBlocked;

  // Keyless local mode. `localMode: true` forces the local engine (documented
  // escape hatch); 'auto' (default) engages it only when no valid key is
  // present. In production builds `@sentientui/core/local` resolves to a stub
  // and this degrades to a no-op client + one console.error per page load
  // (createLocalModeClient handles that), so no NODE_ENV check is needed here.
  const keyValid = typeof config.apiKey === 'string' && config.apiKey.startsWith('pk_');
  if (config.localMode === true || (!keyValid && config.localMode !== false)) {
    // One registration for both arms (they used to duplicate this set call).
    // upgrade stays null — there is no hosted client to swap in — but the
    // reason lets grantConsent() explain that instead of no-oping silently.
    _clients.set(config.apiKey || 'local', {
      config,
      upgrade: null,
      upgradeBlockedReason:
        '[sentient] grantConsent(): this client is keyless/local — there is no hosted client to upgrade to. Configure a pk_ API key to enable tracking.',
    });
    // A gated visitor must never get the identity cookie. Local mode has no
    // server to serve a statistical winner from, so return a plain no-op.
    if (gated) return SSR_CLIENT;
    return createLocalModeClient(config);
  }

  if (gated) {
    if (!config.apiKey || !config.apiKey.startsWith('pk_')) {
      if (config.preConsentBehavior === 'statistical_winner') {
        console.warn('[sentient] init() called with an invalid apiKey — expected a pk_ public key. SDK disabled.');
      }
      // Registered under the same 'local' fallback key the local branch uses:
      // `config.apiKey` here can be '', and a ''-keyed entry was unreachable
      // by a no-arg grantConsent() (falsy `_lastApiKey`), which then wrongly
      // warned "called before init()".
      _clients.set(config.apiKey || 'local', {
        config,
        upgrade: null,
        upgradeBlockedReason:
          '[sentient] grantConsent(): the client was initialized with an invalid apiKey (expected a pk_ public key) — consent cannot enable tracking.',
      });
      return SSR_CLIENT;
    }
    // Every gated client gets an upgradeable proxy, not just the winner-serving
    // one — otherwise grantConsent() is silently dead for the 'control' default
    // and the site has to reload to start tracking. Control mode still makes no
    // request; the proxy only exists so consent can swap the inner client.
    const { proxy, setInner } = createPreConsentProxy(config);
    // Under DNT the read-only winner still serves, but consent can never
    // upgrade it to tracking — so drop the upgrade hook.
    _clients.set(config.apiKey, { config, upgrade: dntBlocked ? null : setInner });
    return proxy;
  }

  if (!config.apiKey || !config.apiKey.startsWith('pk_')) {
    console.warn('[sentient] init() called with an invalid apiKey — expected a pk_ public key. SDK disabled.');
    return SSR_CLIENT;
  }

  if (config.ingestUrl === '') {
    console.warn('[sentient] init() called with an empty ingestUrl. SDK disabled.');
    return SSR_CLIENT;
  }

  const resolvedIngestUrl = config.ingestUrl ?? DEFAULT_INGEST_URL;

  const sessionStart = Date.now();
  const session = initSession({ ssrSessionId: config.ssrSessionId, apiKey: config.apiKey });
  const assignmentCache = createAssignmentCache(undefined, config.apiKey);
  const eventQueue = createEventQueue({ ingestUrl: resolvedIngestUrl, apiKey: config.apiKey });
  const baseUrl = deriveBaseUrl(resolvedIngestUrl);

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  } as const;

  // Conversions get the same durable transport the event queue has always had:
  // retry with backoff, a cross-reload bucket, dedupe on the server's goalId.
  // One warning per distinct drop status per page load (see onDrop below).
  const warnedDropStatuses = new Set<number>();
  const goalQueue: GoalQueue = createGoalQueue({
    url: `${baseUrl}/goals`,
    apiKey: config.apiKey,
    headers: authHeaders,
    onDrop: (goal, status) => {
      // NOT debug-gated. CONTRACTS §7 says a dropped goal is reported to the
      // developer and never swallowed, but this returned early unless debug was
      // on — so in production a rate-limited or misconfigured project lost every
      // conversion with no signal anywhere. Warn once per (status, page load):
      // enough to be discoverable in a console or an error reporter, quiet
      // enough that a broken integration cannot flood the page.
      if (!config.debug) {
        if (warnedDropStatuses.has(status)) return;
        warnedDropStatuses.add(status);
      }
      console.warn(
        `[sentient] goal dropped (HTTP ${status}) — this will not be retried. ` +
          (status === 400
            ? 'The session was not found: call init() and let the session upsert complete before firing goals.'
            : status === 401 || status === 403
              ? 'Check the API key and that this origin is on the project allowlist.'
              : 'See the response status for the cause.'),
        goal,
      );
    },
  });

  const deviceClass = detectDeviceClass(navigator.userAgent ?? '');
  // No window guard here: init() already returned SSR_CLIENT at the top when
  // window is undefined, so the old `typeof window` ternary was dead code.
  const appOrigin = window.location.origin;
  const trafficSource = detectTrafficSource(document.referrer ?? '', appOrigin);
  const sessionSegment =
    config.sessionSegment ?? `${deviceClass}:${trafficSource}`;
  const inflightAssigns = new Map<string, Promise<AssignResult | null>>();
  // Mirrors inflightAssigns for decide(): per-slot lazy-decide patterns (see
  // local-mode's merge comment — one decide({ slots: [decl] }) per mounted
  // slot, all in the same tick) otherwise issue N roundtrips and N snapshot
  // rewrites for one page. Keyed by the full request payload, never just "a
  // decide is running": coalescing {slots:[a]} with {slots:[b]} would hand
  // slot b's caller an outcome that never decided b.
  const inflightDecides = new Map<string, Promise<DecideOutcome | null>>();

  // --- Adaptive-slot state (decide) ---
  // Results served for this session, keyed by slot id. Written by decide();
  // read by getSlotResult() (Task 3.3) and componentGoal's slot fallback.
  const slotStore = new Map<string, SlotResult>();
  let personaState: { persona: string; confidence: number } | null = null;

  // On decide failure every declared slot must still resolve — to its baseline.
  // Never overwrite a previously served result.
  const seedSlotBaselines = (decls: SlotDeclInput[]): void => {
    for (const d of decls) {
      if (!slotStore.has(d.id)) slotStore.set(d.id, baselineResultFor(d));
    }
  };

  // Seed slot/persona state. Priority: explicit SSR seeds → snapshot.
  if (config.initialSlots) {
    for (const [slotId, result] of Object.entries(config.initialSlots)) {
      slotStore.set(slotId, result);
    }
  }
  const seedSnapshot = readSnapshot(config.apiKey);
  if (seedSnapshot) {
    for (const [slotId, result] of Object.entries(seedSnapshot.slots)) {
      if (!slotStore.has(slotId)) slotStore.set(slotId, result);
    }
  }

  // Band-only persona sources (html attrs, snapshot) become a band-consistent
  // numeric confidence so confidenceBand(confidence) always equals the band.
  const BAND_CONFIDENCE: Record<string, number> = { low: 0.15, medium: 0.5, high: 0.85 };
  if (config.initialPersona) {
    personaState = { ...config.initialPersona };
  } else {
    // Single-writer rule: the inline pre-paint script owns the <html>
    // attributes. The client ADOPTS them as truth and never rewrites them
    // mid-session (next visit's script picks up the new snapshot instead).
    const ds = document.documentElement.dataset;
    if (ds.sentientPersona) {
      personaState = {
        persona: ds.sentientPersona,
        confidence: BAND_CONFIDENCE[ds.sentientConfidence ?? 'low'] ?? 0.15,
      };
    } else if (seedSnapshot) {
      personaState = {
        persona: seedSnapshot.persona,
        confidence: BAND_CONFIDENCE[seedSnapshot.band] ?? 0.15,
      };
    }
  }

  // Seed SSR-preloaded assignments into the local cache so assign() finds a
  // cache hit immediately — no network call, no variant flash on hydration.
  if (config.initialAssignments) {
    for (const [componentId, variantId] of Object.entries(config.initialAssignments)) {
      assignmentCache.set(componentId, sessionSegment, {
        variantId,
        assignedAt: Date.now(),
        segment: sessionSegment,
        confidence: 1,
      });
    }
  }

  // Upsert session metadata once on init. assign() awaits this promise so
  // the server isn't asked to assign for a session row that doesn't exist yet.
  let sessionReady: Promise<void> = Promise.resolve();

  const sessionId = session.getSessionId();
  if (sessionId) {
    const referrerDomain = referrerDomainFromReferer(document.referrer ?? '');
    const { utmParams, clickIds } = readTrackedParams();
    const sessionBody = {
      sessionId,
      deviceClass,
      trafficSource,
      referrerDomain,
      utmParams,
      // Ad-platform click IDs (gclid & co). Captured separately from utmParams
      // because Google Ads auto-tagging appends ONLY gclid — without this,
      // paid search with no manual UTM template reported as organic.
      clickIds,
      timeOfDay: detectTimeOfDay(new Date()),
      dayOfWeek: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()],
      ephemeral: session.isEphemeral(),
      // Likely-automation hint: navigator.webdriver (set under automation
      // control) or a known agent token in the UA. Probabilistic — used for
      // metrics + bandit exclusion server-side, never to change what's served.
      automation:
        (typeof navigator !== 'undefined' && navigator.webdriver === true) ||
        uaTokenMatch(navigator.userAgent ?? ''),
      ...(config.userId ? { userId: config.userId } : {}),
      ...(config.persona ? { persona: config.persona } : {}),
      ...(config.country ? { country: config.country } : {}),
    };
    // The session row is a PRECONDITION for every conversion: /v1/goals answers
    // 400 session_not_found without it, and the durable queue classifies a 4xx
    // as terminal — so a session upsert that fails silently turns every later
    // conversion into a permanent drop. That is not hypothetical: /v1/sessions
    // carries the same per-IP limiter as /v1/goals, so under shared egress
    // (offices, mobile carriers, corporate NAT) the SESSION call 429s first and
    // the goals that follow are dropped for good. Retry it, so a transient
    // failure costs a moment rather than the visit's whole conversion history.
    const upsertSession = async (): Promise<undefined> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(`${baseUrl}/sessions`, {
            method: 'POST',
            keepalive: true,
            body: JSON.stringify(sessionBody),
            headers: authHeaders,
          });
          if (res.status === 402) {
            console.warn(
              '[SentientUI] Session limit exceeded for this project. The bandit will stop learning until the limit resets. Upgrade at sentient-ui.com/pricing',
            );
            return undefined; // terminal: retrying a quota will not clear it
          }
          if (res.ok || classifyResponse(res) === 'dropped') return undefined;
        } catch {
          /* network failure — same retry path as a 5xx */
        }
        if (attempt >= SESSION_UPSERT_RETRIES) {
          // Say so once: from here every conversion this visit will 400, and
          // that used to be entirely silent.
          console.warn(
            '[SentientUI] Could not register the session after retries. Conversions in this visit may not be recorded.',
          );
          return undefined;
        }
        await new Promise((r) => setTimeout(r, backoffDelayMs(attempt + 1)));
      }
    };
    try {
      sessionReady = upsertSession();
    } catch {
      /* never throw on init */
    }
  }

  if (config.debug) {
    console.log('[sentient] initialized', { context: config.context });
    (
      window as unknown as {
        __sentient?: {
          client: SentientClient;
          queue: EventQueue;
        };
      }
    ).__sentient = {
      client: null as unknown as SentientClient,
      queue: eventQueue,
    };
  }

  // One user action must record ONE session-level conversion per goal name.
  // Nested components each fire their declared goal on the same click (every
  // <Adaptive>/hook path calls componentGoal() AND goal()), so a hero nested
  // inside a CTA wrapper wrote two goal_events rows for one click: harmless for
  // a weight-1.0 goal (close-out clamps at 1) but a 0.3-weight step summed to
  // 0.6, and the Goals page counts Hits as COUNT(*) either way.
  //
  // The scope is one event dispatch, not one session and no longer one task:
  // see createActionLatch. A session-wide latch would swallow genuine repeat
  // conversions (two purchases in one visit are two conversions), and a
  // time-boxed one did exactly that whenever the box outlived the action.
  // Calls carrying distinct externalIds are never collapsed — those are, by
  // definition, distinct orders.
  const firedThisAction = createActionLatch();

  // Set once tracking starts; dispose() and destroy() call it so a replaced
  // client stops watching history instead of emitting forever. The flag records
  // teardown for the delivery-marking below, which runs on a later microtask.
  let stopPageviews: (() => void) | null = null;
  let pageviewsTornDown = false;

  const client: SentientClient = {
    goal(name: string, metadataOrOpts: Record<string, unknown> = {}, weight = 1.0, stepIndex = 0) {
      const sid = session.getSessionId();
      if (!sid) return;
      const opts: GoalOptions = isGoalOptions(metadataOrOpts)
        ? (metadataOrOpts as GoalOptions)
        : { metadata: metadataOrOpts };
      // stepIndex and weight are part of the key: funnel steps share a goal
      // name and differ by stepIndex, so collapsing on name alone dropped a
      // step fired in the same handler. Only IDENTICAL calls are one action.
      //
      // value and currency key the payload SEPARATELY (the latch's valueKey),
      // not as more segments of the flat key, and for a costlier reason: they
      // are the money. Flattened out of the key entirely, a $50 order and a
      // $70 order landing in one window collapsed into a single $50 record —
      // the client half of CONTRACTS §1 "two orders are worth two orders",
      // which the server already honours (migration 119 records the repeat if
      // it arrives; this is what stopped it arriving). But flattened INTO the
      // key, a valued inner component nested in a valueless wrapper made two
      // keys out of one click — two rows for one order. So the latch compares
      // values only between valued fires ($50 vs $70 stays two records) and
      // lets a valued record absorb a valueless re-fire of the same action
      // (see createActionLatch for the one asymmetric case).
      //
      // NOT metadata: every nested <Adaptive>/hook path stamps its own
      // componentId and variantId in there, so keying on it would make the
      // duplicate this latch exists to collapse look distinct again.
      const actionKey = [
        name,
        opts.externalId ?? '',
        opts.stepIndex ?? stepIndex,
        opts.weight ?? weight,
      ].join('\0');
      const valueKey = opts.value !== undefined ? `${opts.value}\0${opts.currency ?? ''}` : null;
      if (firedThisAction.firedBefore(actionKey, valueKey)) {
        if (config.debug) {
          console.log(`[sentient] goal("${name}") already recorded for this action — not sent twice`);
        }
        return;
      }
      const goalId = generateEventId();
      // undefined values vanish at JSON.stringify time, so optional fields
      // need no conditional assembly.
      const body = {
        sessionId: sid,
        name,
        metadata: opts.metadata ?? {},
        weight: opts.weight ?? weight,
        stepIndex: opts.stepIndex ?? stepIndex,
        goalId,
        value: opts.value,
        currency: opts.currency,
        externalId: opts.externalId,
      };
      if (config.debug) {
        console.log('[sentient] goal', body);
      }
      // Serialize once, here: the queued copy must replay byte-identically
      // (same goalId) so a retry dedupes server-side instead of double-counting.
      const payload = { id: goalId, body: JSON.stringify(body) };
      sessionReady.then(() => goalQueue.send(payload));
    },

    componentGoal(componentId, goalType, opts) {
      const sid = session.getSessionId();
      if (!sid) return;
      // Variant experiments resolve from the assignment cache; adaptive slots
      // (useAdaptiveTokens / AdaptiveGroup) resolve from the slot state, using
      // the canonical arm string as the attributed variantId.
      const assignment = assignmentCache.get(componentId, sessionSegment);
      const slotResult = assignment ? null : slotStore.get(componentId) ?? null;
      if (!assignment && slotResult === null) {
        if (config.debug) {
          console.warn(
            `[sentient] componentGoal("${componentId}"): no assignment or slot decision yet — render its <Adaptive>/adaptive hook or call assign()/decide() before recording a goal.`,
          );
        }
        return;
      }
      const attributedVariantId = assignment ? assignment.variantId : armOfResult(slotResult!);
      const fullEvent: SentientEvent = {
        id: generateEventId(),
        sessionId: sid,
        projectId: config.apiKey,
        componentId,
        variantId: attributedVariantId,
        eventType: 'goal_achieved',
        goalType,
        // undefined goalValue/currency vanish at JSON.stringify time.
        payload: {
          reward: opts?.reward ?? 1,
          goalValue: opts?.value,
          currency: opts?.currency,
          ...(opts?.metadata ?? {}),
        },
        timestamp: Date.now(),
        timeInSession: Date.now() - sessionStart,
        path: currentPath(),
      };
      if (config.debug) {
        console.log('[sentient] componentGoal', fullEvent);
      }
      sessionReady.then(() => eventQueue.push(fullEvent));
    },

    identify(userId) {
      const sid = session.getSessionId();
      if (!sid) return;
      sessionReady.then(() => {
        fetch(`${baseUrl}/sessions`, {
          method: 'POST',
          keepalive: true,
          body: JSON.stringify({ sessionId: sid, userId, ephemeral: session.isEphemeral() }),
          headers: authHeaders,
        }).catch(() => undefined);
      });
    },

    track(event) {
      const sessionId = session.getSessionId();
      if (!sessionId) return;

      const fullEvent: SentientEvent = {
        // `path` first so an explicit event.path from the caller wins over the
        // ambient one — a server-side or replayed event knows its page better
        // than location does.
        path: currentPath(),
        ...event,
        id: generateEventId(),
        sessionId,
        timestamp: Date.now(),
        timeInSession: Date.now() - sessionStart,
      };

      if (config.debug) {
        console.log('[sentient] track', fullEvent);
      }

      sessionReady.then(() => eventQueue.push(fullEvent));
    },

    getAssignment(componentId, segment) {
      return assignmentCache.get(componentId, segment);
    },

    async assign(componentId, variantIds, agentData?, agentDataByVariant?) {
      const sid = session.getSessionId();
      if (!sid) return null;

      const cached = assignmentCache.get(componentId, sessionSegment);
      // When variantIds are provided (A/B code variant), a cache hit is always final.
      // When variantIds are absent (managed text component), only hit the cache if content
      // is present — a seed from initialAssignments has no content and must still fetch.
      if (cached && (variantIds?.length || cached.content !== undefined)) {
        // Surface the entry's remaining TTL (server-provided when set) instead of
        // a hardcoded 0, so callers can reason about when a re-assign is due.
        const remainingTtlMs =
          cached.ttlMs && cached.ttlMs > 0
            ? Math.max(0, cached.assignedAt + cached.ttlMs - Date.now())
            : 0;
        return { variantId: cached.variantId, assignmentTtlMs: remainingTtlMs, content: cached.content };
      }

      // Coalesce concurrent assigns for the same component (e.g. several
      // mounted slots sharing one id) into a single network request.
      return coalesce(inflightAssigns, componentId, async () => {
        await sessionReady;
        try {
          const body: Record<string, unknown> = { sessionId: sid, componentId, variantIds };
          if (agentDataByVariant !== undefined) body.agentDataByVariant = agentDataByVariant;
          else if (agentData !== undefined) body.agentData = agentData;
          const res = await fetch(`${baseUrl}/assign`, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: authHeaders,
          });
          if (!res.ok) return null;
          const result = (await res.json()) as AssignResult;
          assignmentCache.set(componentId, sessionSegment, {
            variantId: result.variantId,
            assignedAt: Date.now(),
            segment: sessionSegment,
            confidence: 1,
            content: result.content,
            // Honor the server's TTL as this entry's expiry; omit when absent/0
            // so the cache falls back to its default (DEFAULT_TTL_MS).
            ...(result.assignmentTtlMs && result.assignmentTtlMs > 0
              ? { ttlMs: result.assignmentTtlMs }
              : {}),
          });
          return result;
        } catch {
          return null;
        }
      });
    },

    async decide(input) {
      const sid = session.getSessionId();
      if (!sid) return null;
      const declared = input.slots ?? [];

      const body: Record<string, unknown> = { sessionId: sid };
      if (input.sections && input.sections.length > 0) {
        body.sections = input.sections.map((id) => ({ id }));
      }
      body.components = input.components ?? [];
      if (declared.length > 0) body.slots = declared.map(toWireSlot);
      if (input.slotsFrom === 'registry') body.slotsFrom = 'registry';
      if (input.v) body.v = input.v;
      // Declared persona rides on decide too: SSR-first flows can race the
      // session upsert, and the decide-body value wins for this decision.
      if (config.persona) body.persona = config.persona;

      // Coalesce concurrent IDENTICAL decides into one request + one snapshot
      // write, keyed by the serialized wire payload (also reused as the fetch
      // body). Never key on just "a decide is running": coalescing {slots:[a]}
      // with {slots:[b]} would hand slot b's caller an outcome that never
      // decided b. The wire projection is a safe key even though toWireSlot
      // strips SDK-only decl fields — the baselines synthesized for omitted
      // slots below go through baselineResultFor, which projects with the
      // same toWireSlot, so identical payloads imply identical outcomes.
      const decideKey = JSON.stringify(body);
      return coalesce(inflightDecides, decideKey, async () => {
        await sessionReady;
        try {
          const res = await fetch(`${baseUrl}/decide`, {
            method: 'POST',
            body: decideKey,
            headers: authHeaders,
          });
          if (!res.ok) {
            seedSlotBaselines(declared);
            return null;
          }
          const data = (await res.json()) as {
            layoutOrder?: string[] | null;
            assignments?: Record<string, string>;
            slots?: Record<string, SlotResult>;
            slotConfig?: Record<string, SlotConfigEntry>;
            goals?: GoalDefinition[];
            sectionMap?: SectionMapEntry[];
            palette?: import('./blocks.js').SitePalette;
            persona?: string;
            confidence?: number;
          };

          const slots: Record<string, SlotResult> = {};
          for (const d of declared) {
            // `data.slots === undefined` means the server predates the slots
            // contract: serve the declared baseline everywhere, do NOT retry.
            // (Distinct from `slots: {}`, which also falls back per-slot.)
            const served = data.slots?.[d.id];
            if (served !== undefined) {
              slots[d.id] = served;
              slotStore.set(d.id, served);
              continue;
            }
            // Slot omitted from the response → synthesize a baseline for the
            // RETURN value, but apply the same never-overwrite rule the failure
            // path (seedSlotBaselines) has always had. This success path used
            // to write unconditionally, so a partial response — or a pre-slots
            // server — clobbered SSR-seeded and previously-served results with
            // synthetic baselines.
            const prior = slotStore.get(d.id);
            if (prior !== undefined) {
              slots[d.id] = prior;
            } else {
              const baseline = baselineResultFor(d);
              slots[d.id] = baseline;
              slotStore.set(d.id, baseline);
            }
          }
          // Registry mode: the server returns slots the request never declared.
          // Take them verbatim (classic mode returns only declared slots, so this
          // union is a no-op there — back-compatible). These are real served
          // results, so they may overwrite the store, unlike the baselines above.
          if (data.slots) {
            for (const [slotId, result] of Object.entries(data.slots)) {
              if (!(slotId in slots)) {
                slots[slotId] = result;
                slotStore.set(slotId, result);
              }
            }
          }
          // Only overwrite persona when the response actually carries one, and
          // never downgrade a known persona to 'unknown' — a decide that omits
          // persona (or returns 'unknown') must not clobber a good SSR/snapshot/
          // initialPersona value, and must not persist that regression below.
          const known = personaState != null && personaState.persona !== 'unknown';
          if (data.persona && !(data.persona === 'unknown' && known)) {
            personaState = { persona: data.persona, confidence: data.confidence ?? 0 };
          } else if (!personaState) {
            personaState = { persona: 'unknown', confidence: 0 };
          }

          // Seed component assignments so <Adaptive>/assign() agree with this
          // decide (same shape as the initialAssignments seed above).
          for (const [componentId, variantId] of Object.entries(data.assignments ?? {})) {
            assignmentCache.set(componentId, sessionSegment, {
              variantId,
              assignedAt: Date.now(),
              segment: sessionSegment,
              confidence: 1,
            });
          }

          // Persist for the next visit's pre-paint (SPA cache-first pattern).
          writeSnapshot(config.apiKey, {
            v: 1,
            persona: personaState.persona,
            band: confidenceBand(personaState.confidence),
            slots: Object.fromEntries(slotStore),
            layoutOrder: data.layoutOrder ?? null,
            savedAt: Date.now(),
            ...(data.slotConfig ? { slotConfig: data.slotConfig } : {}),
            ...(data.palette ? { palette: data.palette } : {}),
          });

          return {
            layoutOrder: data.layoutOrder ?? null,
            assignments: data.assignments ?? {},
            slots,
            persona: personaState.persona,
            confidence: personaState.confidence,
            ...(data.slotConfig ? { slotConfig: data.slotConfig } : {}),
            ...(data.goals ? { goals: data.goals } : {}),
            ...(data.sectionMap ? { sectionMap: data.sectionMap } : {}),
            ...(data.palette ? { palette: data.palette } : {}),
          };
        } catch {
          seedSlotBaselines(declared);
          return null;
        }
      });
    },

    getSlotResult(slotId) {
      return slotStore.get(slotId) ?? null;
    },

    getPersona() {
      if (!personaState) return null;
      return {
        persona: personaState.persona,
        confidence: personaState.confidence,
        band: confidenceBand(personaState.confidence),
      };
    },

    async fetchWeights() {
      try {
        const res = await fetch(`${baseUrl}/weights`, { headers: authHeaders });
        if (!res.ok) return [];
        const data = (await res.json()) as { components: ComponentWeightEntry[] };
        return data.components ?? [];
      } catch {
        return [];
      }
    },

    getGraph() {
      return { pageNodes: [], capturedAt: 0 };
    },

    dispose() {
      // Stops the flush timer and unload listeners (with a final flush) but
      // leaves identity, snapshot, and retry buckets for the next client.
      stopPageviews?.();
      pageviewsTornDown = true;
      eventQueue.destroy();
      goalQueue.destroy();
      // Drop the registry entry so a later re-init doesn't try to dispose an
      // already-torn-down client (and so the map doesn't pin this closure).
      if (_clients.get(config.apiKey)?.dispose === client.dispose) {
        _clients.delete(config.apiKey);
      }
      if (config.debug) {
        console.log('[sentient] disposed');
      }
    },

    destroy() {
      stopPageviews?.();
      pageviewsTornDown = true;
      eventQueue.destroy();
      goalQueue.destroy();
      session.destroy();
      // The assignment cache persists in localStorage (`_snt_asgn_*`) with a
      // 30-minute default TTL — left in place, a revoked visitor returning
      // within that window was handed their previous personalized variants
      // back, so forget-me wasn't total.
      assignmentCache.clear();
      if (_clients.get(config.apiKey)?.dispose === client.dispose) {
        _clients.delete(config.apiKey);
      }
      // Forget-me must be total: a surviving decision snapshot would
      // re-personalize the next visit via the pre-paint script, and a
      // persisted retry bucket would re-send events for the deleted identity.
      try {
        localStorage.removeItem(SNAPSHOT_STORAGE_KEY_PREFIX + config.apiKey);
        localStorage.removeItem(retryStorageKey(config.apiKey));
        localStorage.removeItem(goalRetryStorageKey(config.apiKey));
      } catch {
        /* storage unavailable — nothing persisted to remove */
      }
      if (config.debug) {
        console.log('[sentient] destroyed');
      }
    },
  };

  _clients.set(config.apiKey, { config, upgrade: null, dispose: client.dispose });

  stopPageviews = startPageviewTracking(client, config.apiKey, (key) => {
    // track() defers its enqueue on sessionReady; chaining after it means this
    // runs once the push has happened. If the client was torn down first, the
    // event went into a destroyed queue and never ships — leave the page
    // unmarked so the replacement client's emit is the one that counts.
    void sessionReady.then(() => {
      if (!pageviewsTornDown) emittedPages.add(key);
    });
  });

  if (config.debug) {
    const win = window as unknown as { __sentient?: { client: SentientClient } };
    if (win.__sentient) {
      win.__sentient.client = client;
    }
  }

  return client;
}
