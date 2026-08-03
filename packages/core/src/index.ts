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

export { PROD_KEYLESS_ERROR, LOCAL_MODE_BANNER } from './local-mode.js';

export {
  detectDeviceClass,
  detectTrafficSource,
  detectTimeOfDay,
  deriveSessionSegment,
  referrerDomainFromReferer,
  uaTokenMatch,
  matchedAgentToken,
  agentUaList,
} from './session-meta.js';

const DEFAULT_INGEST_URL = 'https://api.sentient-ui.com/v1/events';

// Keyed by apiKey so multiple init() calls (HMR, multi-project) don't collide.
const _clients = new Map<string, {
  config: SentientConfig;
  upgrade: ((c: SentientClient) => void) | null;
  // Teardown for the live client bound to this key (stops its queue interval +
  // unload listeners). Present only for the full tracking client; the no-op /
  // pre-consent / local entries have nothing to tear down. Called before a
  // re-init for the same key replaces it, so timers/listeners can't leak.
  dispose?: () => void;
}>();
let _lastApiKey: string | null = null;

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

/** An editor-defined goal delivered with a registry-mode decision, for the
 *  snippet to install delegated listeners from. */
export type GoalDefinition = {
  goalId: string;
  event: 'click' | 'form_submit' | 'url_reached';
  locator?: CompoundLocator;
  urlPattern?: string;
  slotId?: string;
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

export type ComponentGoalOptions = {
  /** Reward credited to the served variant (0–1). Defaults to 1. */
  reward?: number;
  /** Extra fields merged into the event payload. */
  metadata?: Record<string, unknown>;
};

export type SentientClient = {
  track(
    event: Omit<SentientEvent, 'id' | 'sessionId' | 'timestamp' | 'timeInSession'>,
  ): void;
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

function generateEventId(): string {
  return randomUuidV4();
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

function readUtmParams(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    const sp = new URLSearchParams(window.location.search);
    for (const [k, v] of sp) {
      if (k.startsWith('utm_')) out[k] = v;
    }
    return out;
  } catch {
    return {};
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
 * Upgrades a pre-consent client (created with `consent: false, preConsentBehavior: 'statistical_winner'`)
 * to a fully-tracking client. Call this from your consent management platform callback.
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

  const { config, upgrade } = entry;
  if (!upgrade) return;

  // Honor an active Do Not Track signal — consent cannot override a global opt-out.
  if (config.respectDoNotTrack !== false && isDoNotTrackEnabled()) return;

  const fullClient = init({ ...config, consent: true });
  upgrade(fullClient);
  // init() just registered the full client (with its dispose) under `key`.
  // Preserve that dispose so a later re-init/teardown can still tear it down —
  // we only need to clear the upgrade hook now that consent is granted.
  const disposed = _clients.get(key)?.dispose;
  _clients.set(key, { config: { ...config, consent: true }, upgrade: null, dispose: disposed });
}

function createPreConsentProxy(config: SentientConfig): { proxy: SentientClient; setInner: (c: SentientClient) => void } {
  const baseUrl = deriveBaseUrl(config.ingestUrl ?? DEFAULT_INGEST_URL);
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  } as const;

  let inner: SentientClient = {
    track: () => undefined,
    goal: () => undefined,
    componentGoal: () => undefined,
    identify: () => undefined,
    getAssignment: () => null,
    fetchWeights: () => Promise.resolve([]),
    async assign(componentId, variantIds, _agentData?) {
      try {
        const params = new URLSearchParams({ componentId });
        for (const v of variantIds ?? []) params.append('variantIds[]', v);
        const res = await fetch(`${baseUrl}/winner?${params.toString()}`, {
          headers: authHeaders,
        });
        if (!res.ok) return variantIds?.[0] ? { variantId: variantIds[0], assignmentTtlMs: 0 } : null;
        const body = (await res.json()) as { variantId: string };
        return { variantId: body.variantId, assignmentTtlMs: 0 };
      } catch {
        return variantIds?.[0] ? { variantId: variantIds[0], assignmentTtlMs: 0 } : null;
      }
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
    goal: (n, m, w, s) => inner.goal(n, m, w, s),
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
 * Initializes the Sentient client. Returns a no-op client during SSR.
 */
export function init(config: SentientConfig): SentientClient {
  if (typeof window === 'undefined') {
    return SSR_CLIENT;
  }

  _lastApiKey = config.apiKey;

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
    // A gated visitor must never get the identity cookie. Local mode has no
    // server to serve a statistical winner from, so return a plain no-op.
    if (gated) {
      _clients.set(config.apiKey || 'local', { config, upgrade: null });
      return SSR_CLIENT;
    }
    _clients.set(config.apiKey || 'local', { config, upgrade: null });
    return createLocalModeClient(config);
  }

  if (gated) {
    if (config.preConsentBehavior === 'statistical_winner') {
      if (!config.apiKey || !config.apiKey.startsWith('pk_')) {
        console.warn('[sentient] init() called with an invalid apiKey — expected a pk_ public key. SDK disabled.');
        return SSR_CLIENT;
      }
      const { proxy, setInner } = createPreConsentProxy(config);
      // Under DNT the read-only winner still serves, but consent can never
      // upgrade it to tracking — so drop the upgrade hook.
      _clients.set(config.apiKey, { config, upgrade: dntBlocked ? null : setInner });
      return proxy;
    }
    _clients.set(config.apiKey, { config, upgrade: null });
    return SSR_CLIENT;
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
  const session = initSession({ ssrSessionId: config.ssrSessionId });
  const assignmentCache = createAssignmentCache();
  const eventQueue = createEventQueue({ ingestUrl: resolvedIngestUrl, apiKey: config.apiKey });
  const baseUrl = deriveBaseUrl(resolvedIngestUrl);

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  } as const;

  const deviceClass = detectDeviceClass(navigator.userAgent ?? '');
  const appOrigin = typeof window !== 'undefined' ? window.location.origin : undefined;
  const trafficSource = detectTrafficSource(document.referrer ?? '', appOrigin);
  const sessionSegment =
    config.sessionSegment ?? `${deviceClass}:${trafficSource}`;
  const inflightAssigns = new Map<string, Promise<AssignResult | null>>();

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
    const sessionBody = {
      sessionId,
      deviceClass,
      trafficSource,
      referrerDomain,
      utmParams: readUtmParams(),
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
      ...(config.country ? { country: config.country } : {}),
    };
    try {
      sessionReady = fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        keepalive: true,
        body: JSON.stringify(sessionBody),
        headers: authHeaders,
      })
        .then((res) => {
          if (res.status === 402) {
            console.warn(
              '[SentientUI] Session limit exceeded for this project. The bandit will stop learning until the limit resets. Upgrade at sentient-ui.com/pricing',
            );
          }
          return undefined;
        })
        .catch(() => undefined);
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

  const client: SentientClient = {
    goal(name, metadata = {}, weight = 1.0, stepIndex = 0) {
      const sid = session.getSessionId();
      if (!sid) return;
      const goalId = generateEventId();
      sessionReady.then(() => {
        fetch(`${baseUrl}/goals`, {
          method: 'POST',
          keepalive: true,
          body: JSON.stringify({ sessionId: sid, name, metadata, weight, stepIndex, goalId }),
          headers: authHeaders,
        }).catch(() => undefined);
      });
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
        payload: { reward: opts?.reward ?? 1, ...(opts?.metadata ?? {}) },
        timestamp: Date.now(),
        timeInSession: Date.now() - sessionStart,
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
      const inflight = inflightAssigns.get(componentId);
      if (inflight) return inflight;

      const request = (async (): Promise<AssignResult | null> => {
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
        } finally {
          inflightAssigns.delete(componentId);
        }
      })();
      inflightAssigns.set(componentId, request);
      return request;
    },

    async decide(input) {
      const sid = session.getSessionId();
      if (!sid) return null;
      const declared = input.slots ?? [];
      await sessionReady;
      try {
        const body: Record<string, unknown> = { sessionId: sid };
        if (input.sections && input.sections.length > 0) {
          body.sections = input.sections.map((id) => ({ id }));
        }
        body.components = input.components ?? [];
        if (declared.length > 0) body.slots = declared.map(toWireSlot);
        if (input.slotsFrom === 'registry') body.slotsFrom = 'registry';
        if (input.v) body.v = input.v;

        const res = await fetch(`${baseUrl}/decide`, {
          method: 'POST',
          body: JSON.stringify(body),
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
          persona?: string;
          confidence?: number;
        };

        const slots: Record<string, SlotResult> = {};
        for (const d of declared) {
          // `data.slots === undefined` means the server predates the slots
          // contract: serve the declared baseline everywhere, do NOT retry.
          // (Distinct from `slots: {}`, which also falls back per-slot.)
          slots[d.id] = data.slots?.[d.id] ?? baselineResultFor(d);
        }
        // Registry mode: the server returns slots the request never declared.
        // Take them verbatim (classic mode returns only declared slots, so this
        // union is a no-op there — back-compatible).
        if (data.slots) {
          for (const [slotId, result] of Object.entries(data.slots)) {
            if (!(slotId in slots)) slots[slotId] = result;
          }
        }
        for (const [slotId, result] of Object.entries(slots)) slotStore.set(slotId, result);
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
        };
      } catch {
        seedSlotBaselines(declared);
        return null;
      }
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
      // leaves identity, snapshot, and retry bucket for the next client.
      eventQueue.destroy();
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
      eventQueue.destroy();
      session.destroy();
      if (_clients.get(config.apiKey)?.dispose === client.dispose) {
        _clients.delete(config.apiKey);
      }
      // Forget-me must be total: a surviving decision snapshot would
      // re-personalize the next visit via the pre-paint script, and a
      // persisted retry bucket would re-send events for the deleted identity.
      try {
        localStorage.removeItem(SNAPSHOT_STORAGE_KEY_PREFIX + config.apiKey);
        localStorage.removeItem(retryStorageKey(config.apiKey));
      } catch {
        /* storage unavailable — nothing persisted to remove */
      }
      if (config.debug) {
        console.log('[sentient] destroyed');
      }
    },
  };

  _clients.set(config.apiKey, { config, upgrade: null, dispose: client.dispose });

  if (config.debug) {
    const win = window as unknown as { __sentient?: { client: SentientClient } };
    if (win.__sentient) {
      win.__sentient.client = client;
    }
  }

  return client;
}
