'use client';

declare const process: { env?: { NODE_ENV?: string } } | undefined;

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  detectDeviceClass,
  detectTrafficSource,
  init,
  type SentientClient,
  type SentientConfig,
  type SlotResult,
} from '@sentientui/core';
import { update as updateWeightsStore, type ComponentWeights } from './weights-store.js';
import { getPreviewMode, subscribePreview, createPreviewClient } from './preview-mode.js';
import { subscribeOverridesChanged } from './override-events.js';
import { publishDevtoolsConfig } from './devtools-config.js';
import { registerSections } from './devtools-registry.js';

/**
 * Mirrors the segment derivation inside core `init()` so the cache key used
 * by `useAssignment` always matches the key `assign()` writes under. Before
 * this, the context defaulted to 'desktop:direct' while core used the
 * detected segment — a systematic cache miss for every integration that
 * didn't pass `sessionSegment` explicitly.
 */
function deriveDefaultSegment(): string {
  if (typeof window === 'undefined') return 'desktop:direct';
  try {
    const device = detectDeviceClass(navigator.userAgent ?? '');
    const source = detectTrafficSource(document.referrer ?? '', window.location.origin);
    return `${device}:${source}`;
  } catch {
    return 'desktop:direct';
  }
}

const DEFAULT_API_BASE_URL = 'https://api.sentient-ui.com/v1';

/** How to render adaptive slots during SSR when assignments are not preloaded. */
export type SsrFallback = 'first' | 'none';

type AdaptiveContextValue = {
  client: SentientClient | null;
  // The publishable API key (pk_…). Historically named `projectId` because the
  // API uses it as the project identifier on the wire, but it is the API key,
  // not the project UUID. Field renamed for clarity.
  apiKey: string;
  initialAssignments: Record<string, string>;
  sessionSegment: string;
  ssrFallback: SsrFallback;
  onAssignment: ((componentId: string, variantId: string) => void) | undefined;
  initialLayoutOrder: string[] | null;
  initialSlots: Record<string, SlotResult>;
  initialPersona: { persona: string; confidence: number } | null;
  apiBaseUrl: string;
  debug: boolean;
};

const AdaptiveContext = createContext<AdaptiveContextValue>({
  client: null,
  apiKey: '',
  initialAssignments: {},
  sessionSegment: 'desktop:direct',
  ssrFallback: 'first',
  onAssignment: undefined,
  initialLayoutOrder: null,
  initialSlots: {},
  initialPersona: null,
  apiBaseUrl: DEFAULT_API_BASE_URL,
  debug: false,
});

export type AdaptiveProviderProps = {
  apiKey: string;
  context: SentientConfig['context'];
  debug?: boolean;
  /**
   * SSR-preloaded assignments from `preloadAssignments()` / `loadAdaptiveAssignments()`.
   * Passed through to `useAssignment` as synchronous initial state so crawlers and
   * the first paint see real content (recommended for SEO).
   */
  initialAssignments?: Record<string, string>;
  /**
   * Bandit segment from SSR (`device:source`). Keeps cache, assign, and worker
   * weights on one row — must match `loadAdaptiveAssignments` / session upsert.
   */
  sessionSegment?: string;
  /**
   * When no `initialAssignments` exist for a component, `'first'` renders
   * `variantIds[0]` in server HTML (safe default for SEO). Use `'none'` only for
   * decorative slots marked `clientOnly`.
   * @default 'first'
   */
  ssrFallback?: SsrFallback;
  /**
   * Consent gate. When `false` the SDK is not initialised and no events are
   * sent. Flip to `true` (e.g. after the user accepts the cookie banner) to
   * initialise and begin tracking.
   */
  consent?: boolean;
  /**
   * Where to read the visitor's consent decision from, so the SDK can gate and
   * un-gate itself instead of the host app wiring `grantConsent()` by hand.
   *
   * Keep your own banner or CMP — this only tells us how to observe it. The
   * provider reads the source on mount, re-reads it whenever `event` fires, and
   * initialises the moment it grants. Nothing is requested and no cookie is set
   * until then, and there is no page reload.
   *
   * Because the provider owns the whole lifecycle there is no ordering rule to
   * get right: pass this instead of managing `consent` yourself.
   *
   * @example // cookie written by your own banner
   * consentFrom={{ cookie: 'cookie_consent', value: 'accepted', event: 'consent-decided' }}
   * @example // a CMP that exposes an object rather than a cookie
   * consentFrom={{ check: () => window.Cookiebot?.consent?.statistics === true,
   *                event: 'CookiebotOnAccept' }}
   */
  consentFrom?: {
    /** Cookie to read. Granted when its value equals `value`. */
    cookie?: string;
    /** Cookie value that means granted. @default 'accepted' */
    value?: string;
    /** Predicate for CMPs with a JS API. Takes precedence over `cookie`. */
    check?: () => boolean;
    /**
     * `window` event that signals a decision. The source is re-read when it
     * fires — the event's payload is never trusted — so any CMP's event works.
     */
    event?: string;
  };
  /**
   * Behavior before consent is granted. Pass `'statistical_winner'` to serve the
   * best-performing variant via `GET /v1/winner` with zero tracking while the
   * consent banner is showing. Requires `consent: false`.
   * @see SentientConfig.preConsentBehavior
   */
  preConsentBehavior?: 'statistical_winner' | 'control';
  /**
   * Honor the browser's Do Not Track signal. Defaults to `true`: when DNT is
   * enabled the SDK sets no cookies and sends no tracking data (overriding
   * `consent: true`). Set `false` to make your own consent gate authoritative.
   * @see SentientConfig.respectDoNotTrack
   */
  respectDoNotTrack?: boolean;
  /**
   * Called once per component the first time a variant is resolved for that
   * component in this session. Use to forward assignments to your own analytics
   * (Mixpanel, PostHog, Segment, etc.) without having to wrap `useAssignment`.
   */
  onAssignment?: (componentId: string, variantId: string) => void;
  /**
   * SSR-preloaded section order from `loadAdaptiveDecision()`.
   * Pass the `layoutOrder` field from `DecideResult`. When set,
   * `useLayoutOrder()` returns this on first render so there is no layout shift.
   */
  initialLayoutOrder?: string[] | null;
  /**
   * SSR-preloaded slot results from `loadAdaptiveDecision()` (the `slots`
   * field of its result). Guarantees `useAdaptiveTokens`/`AdaptiveGroup`
   * render the decided arm in server HTML — zero flicker, hydration-safe.
   */
  initialSlots?: Record<string, SlotResult>;
  /**
   * Persona decided during SSR (`persona` + `confidence` fields of
   * `loadAdaptiveDecision()`'s result). Adopted by the core client;
   * rendered into html attributes only by `SentientPersonaScript`.
   */
  initialPersona?: { persona: string; confidence: number };
  /**
   * Base URL of the Sentient API (no trailing slash). Read by the devtools
   * panel for /v1/explain and by future client helpers. Defaults to the
   * hosted API.
   */
  apiBaseUrl?: string;
  /**
   * Session ID generated during SSR (the `sessionId` field returned by
   * `loadAdaptiveAssignments` / `loadAdaptiveDecision`). When provided and no
   * existing session cookie or localStorage entry is found, the client adopts
   * this ID so events and goals are attributed to the same session the server
   * used for variant assignment.
   */
  ssrSessionId?: string;
  /**
   * ISO 3166-1 alpha-2 country code. Pass the value of the `CF-IPCountry`
   * header from your Next.js server component to populate country on landing
   * sessions without client-side geo lookup.
   */
  country?: string;
  /**
   * Keyless local mode. 'auto' (default) simulates decisions on-device in
   * development builds when no valid API key is configured; `true` forces the
   * local engine; `false` restores the silent keyless no-op.
   * @see SentientConfig.localMode
   */
  localMode?: 'auto' | boolean;
  /**
   * DOM graph scanning + page-structure sync. ON by default: the provider
   * dynamically loads `@sentientui/core/graph` and uses its graph-capable
   * `init()` for the single client, so the SDK scans your page structure,
   * auto-detects semantic sections, and syncs them to power personas and the
   * dashboard graph page. Pass `false` to keep the lean bundle only.
   */
  enableGraph?: boolean;
  /**
   * Include captured heading / DOM text in graph sync payloads. OFF by default.
   * Only applies when graph scanning is enabled (`enableGraph` not `false`).
   */
  captureDomText?: boolean;
  /**
   * Behavioral engagement capture (per-section dwell/scroll + semantic section
   * registration) powering personas. ON by default — pass `false` to disable.
   * Never runs for a DNT/GPC or consent-gated visitor (no client → no capture).
   */
  engagement?: boolean;
  children: ReactNode;
};

/**
 * Watches a {@link AdaptiveProviderProps.consentFrom} source and reports whether
 * it currently grants consent. Returns false (and subscribes to nothing) when no
 * source is configured.
 */
function useConsentSource(source: AdaptiveProviderProps['consentFrom']): boolean {
  const [granted, setGranted] = useState(false);

  // The source is usually an inline object literal, so its identity changes
  // every render. Read it through a ref and key the effect on its primitives,
  // otherwise the listener would be torn down and re-added on every render.
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const { cookie, value, event } = source ?? {};
  const hasCheck = typeof source?.check === 'function';

  useEffect(() => {
    const read = (): boolean => {
      const s = sourceRef.current;
      if (!s) return false;
      if (s.check) return s.check() === true;
      if (!s.cookie || typeof document === 'undefined') return false;
      const want = `${s.cookie}=${s.value ?? 'accepted'}`;
      return document.cookie.split('; ').some((c) => c.trim() === want);
    };

    if (read()) {
      setGranted(true);
      return;
    }
    if (!event) return;

    // Re-read rather than trusting the event payload, so this works with any
    // CMP's event shape (CookiebotOnAccept, OneTrustGroupsUpdated, …) and a
    // "declined" decision correctly leaves us gated.
    const onDecision = (): void => {
      if (read()) setGranted(true);
    };
    window.addEventListener(event, onDecision);
    return () => window.removeEventListener(event, onDecision);
  }, [cookie, value, event, hasCheck]);

  return granted;
}

/**
 * Initialises the Sentient core SDK in a useEffect (SSR-safe) and exposes the
 * client via React context. Re-initialises when consent changes.
 */
export function AdaptiveProvider(props: AdaptiveProviderProps): JSX.Element {
  const [client, setClient] = useState<SentientClient | null>(null);
  // Derived once per mount: identical to what core init() computes, so cache
  // reads (context segment) and cache writes (core segment) always agree.
  const [sessionSegment] = useState(() => props.sessionSegment ?? deriveDefaultSegment());
  // Devtools preview: when on, expose an event-suppressing client so previewing
  // variants/personas writes nothing. Off by default (inert in production).
  const [previewOn, setPreviewOn] = useState(getPreviewMode());
  useEffect(() => subscribePreview(() => setPreviewOn(getPreviewMode())), []);

  // When a consentFrom source is configured it owns the gate: start closed and
  // open only once the source grants. An explicit consent={true} (e.g. resolved
  // from the cookie on the server by AdaptiveRoot) short-circuits it, so a
  // returning visitor isn't gated waiting for a client-side re-read.
  const sourceGranted = useConsentSource(props.consentFrom);
  const consent = props.consentFrom ? props.consent === true || sourceGranted : props.consent;

  useEffect(() => {
    // When consent is explicitly false with no preConsentBehavior, tear down any existing client.
    if (consent === false && !props.preConsentBehavior) {
      setClient((prev: SentientClient | null) => {
        prev?.destroy();
        return null;
      });
      return;
    }

    const config = {
      apiKey: props.apiKey,
      context: props.context,
      debug: props.debug,
      initialAssignments: props.initialAssignments,
      sessionSegment,
      consent,
      preConsentBehavior: props.preConsentBehavior,
      respectDoNotTrack: props.respectDoNotTrack,
      ssrSessionId: props.ssrSessionId,
      country: props.country,
      localMode: props.localMode,
      initialSlots: props.initialSlots,
      initialPersona: props.initialPersona,
      ingestUrl: props.apiBaseUrl ? `${props.apiBaseUrl.replace(/\/$/, '')}/events` : undefined,
    };

    // Track the client created by this effect run so cleanup destroys exactly
    // the right one, and so a late-resolving dynamic import can bail if the
    // effect was already torn down (unmount / consent change).
    let cancelled = false;
    let created: SentientClient | null = null;
    let stopEngagement: (() => void) | null = null;

    // Engagement capture (default ON): per-section dwell/scroll + semantic
    // section registration, lazy-loaded so the lean bundle stays lean. Only
    // ever started for an initialised client, so consent/DNT gates are
    // inherited (and the capture module re-checks DNT internally).
    const startEngagement = (c: SentientClient): void => {
      if (props.engagement === false) return;
      void import('@sentientui/core/engagement').then(({ startEngagementCapture }) => {
        if (cancelled) return;
        stopEngagement = startEngagementCapture(c, {
          apiKey: props.apiKey,
          apiBase: props.apiBaseUrl ? props.apiBaseUrl.replace(/\/$/, '') : undefined,
        });
      });
    };

    if (props.enableGraph !== false) {
      // Graph scanning is the default — load the graph entry dynamically so the
      // scanner never lands in the lean bundle. The provider still creates ONE
      // client (graph-capable). Pass enableGraph={false} for the lean client.
      void import('@sentientui/core/graph').then(({ init: initGraph }) => {
        if (cancelled) return;
        created = initGraph({ ...config, graph: true, captureDomText: props.captureDomText === true });
        setClient(created);
        startEngagement(created);
      });
    } else {
      created = init(config);
      setClient(created);
      startEngagement(created);
    }

    return () => {
      cancelled = true;
      stopEngagement?.();
      // dispose, not destroy: effect cleanup runs on unmount, StrictMode's
      // dev double-invoke, and consent re-init — the visitor identity must
      // survive all of those. Full destroy() happens only on the explicit
      // consent-revocation branch above.
      created?.dispose();
    };
    // Re-init when consent changes — whether that came from the prop or from a
    // consentFrom source granting. Other props (incl. enableGraph) are
    // intentionally stable for a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consent]);

  // Poll /v1/weights every 60 s so long-lived sessions see updated bandit weights
  // without a page reload. useAssignment subscribers react via weights-store.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      if (cancelled) return;
      let entries;
      try {
        entries = await client.fetchWeights();
      } catch {
        // Network/transient error: skip this cycle and retry on the next
        // interval. Swallowed deliberately so a failed poll never surfaces as
        // an unhandled rejection.
        return;
      }
      if (cancelled) return;
      for (const entry of entries) {
        const weights: ComponentWeights = {
          componentId: entry.componentId,
          updatedAt: entry.updatedAt,
          variants: entry.variants.map((v) => ({
            variantId: v.variantId,
            pulls: v.pulls,
            avgReward: v.avgReward ?? 0,
          })),
        };
        updateWeightsStore(entry.componentId, weights);
      }
    };
    void poll();
    const timerId = setInterval(() => void poll(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timerId);
    };
  }, [client]);

  const ssrFallback = props.ssrFallback ?? 'first';
  // Strip a trailing slash so consumers (devtools /explain, useAdaptiveApiBaseUrl)
  // build URLs the same way the core client does (it strips before appending
  // /events and /section-map) — otherwise an apiBaseUrl ending in "/" yields a
  // double slash like ".../v1//explain".
  const apiBaseUrl = (props.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');

  // The init effect above re-runs only on `props.consent`: apiKey / context /
  // country / apiBaseUrl are captured once and are deliberately stable for the
  // session, so changing them at runtime silently no-ops. That silence is
  // surprising — warn (dev only) when one actually changes value after init, so
  // the no-op is visible. To apply a new value, remount the provider (e.g. a
  // changing React `key`).
  const frozenConfigRef = useRef<{
    apiKey: string;
    context: SentientConfig['context'];
    country: string | undefined;
    apiBaseUrl: string;
  } | null>(null);
  useEffect(() => {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') return;
    const current = { apiKey: props.apiKey, context: props.context, country: props.country, apiBaseUrl };
    const prev = frozenConfigRef.current;
    frozenConfigRef.current = current;
    if (prev === null) return; // first run: capture the frozen baseline, nothing to compare
    for (const key of ['apiKey', 'context', 'country', 'apiBaseUrl'] as const) {
      if (!Object.is(prev[key], current[key])) {
        console.warn(
          `[sentient] AdaptiveProvider: \`${key}\` changed after initialisation, but the SDK client is stable for the session and only re-inits on \`consent\` — the new value is ignored. Remount the provider (e.g. via a changing \`key\` prop) to apply it.`,
        );
      }
    }
  }, [props.apiKey, props.context, props.country, apiBaseUrl]);

  // Publish devtools config through window: the /devtools entry is a separate
  // bundle and cannot read this provider's context instance. Dev-only.
  useEffect(() => {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') return;
    publishDevtoolsConfig({
      apiKey: props.apiKey,
      apiBaseUrl,
      isLocal: client?.isLocal === true,
    });
  }, [client, props.apiKey, apiBaseUrl]);

  // Sections registry for devtools /v1/explain + local simulation.
  useEffect(() => {
    if (props.initialLayoutOrder && props.initialLayoutOrder.length > 0) {
      registerSections(props.initialLayoutOrder);
    }
  }, [props.initialLayoutOrder]);

  // The client exposed to consumers — wrapped to suppress events while previewing.
  const exposedClient = useMemo(
    () => (client && previewOn ? createPreviewClient(client) : client),
    [client, previewOn],
  );

  // Memoized so unrelated parent re-renders don't cascade through every
  // useSentient / useAssignment consumer via a fresh context object.
  const value = useMemo<AdaptiveContextValue>(
    () => ({
      client: exposedClient,
      apiKey: props.apiKey,
      initialAssignments: props.initialAssignments ?? {},
      sessionSegment,
      ssrFallback,
      onAssignment: props.onAssignment,
      initialLayoutOrder: props.initialLayoutOrder ?? null,
      initialSlots: props.initialSlots ?? {},
      initialPersona: props.initialPersona ?? null,
      apiBaseUrl,
      debug: props.debug ?? false,
    }),
    [
      exposedClient,
      props.apiKey,
      props.initialAssignments,
      sessionSegment,
      ssrFallback,
      props.onAssignment,
      props.initialLayoutOrder,
      props.initialSlots,
      props.initialPersona,
      apiBaseUrl,
      props.debug,
    ],
  );

  return (
    <AdaptiveContext.Provider value={value}>
      {props.children}
    </AdaptiveContext.Provider>
  );
}

/**
 * Returns the SentientClient, or null until the provider has finished
 * initialising on the client.
 */
export function useSentient(): SentientClient | null {
  return useContext(AdaptiveContext).client;
}

/** Internal: publishable API key carried alongside the client. */
export function useAdaptiveApiKey(): string {
  return useContext(AdaptiveContext).apiKey;
}

/** Internal: SSR-preloaded assignments for hydration-safe first render. */
export function useInitialAssignments(): Record<string, string> {
  return useContext(AdaptiveContext).initialAssignments;
}

/** Internal: bandit segment aligned with SSR session upsert. */
export function useSessionSegment(): string {
  return useContext(AdaptiveContext).sessionSegment;
}

/** Internal: SSR fallback strategy when a slot has no preloaded assignment. */
export function useSsrFallback(): SsrFallback {
  return useContext(AdaptiveContext).ssrFallback;
}

/** Internal: forwarding hook for consumer analytics integration. */
export function useOnAssignment(): ((componentId: string, variantId: string) => void) | undefined {
  return useContext(AdaptiveContext).onAssignment;
}

/** Internal: debug flag from the provider config, for dev-only diagnostic logging. */
export function useDebug(): boolean {
  return useContext(AdaptiveContext).debug;
}

/**
 * Returns the persona-specific section order from SSR, or null when no
 * sections were declared on AdaptiveRoot or reliability is below threshold.
 * Devtools/testing can force it via `window.__sentient_layout_override`;
 * consumers re-render when the devtools notifies an override change.
 */
export function useLayoutOrder(): string[] | null {
  const contextOrder = useContext(AdaptiveContext).initialLayoutOrder;
  const override = useSyncExternalStore(
    subscribeOverridesChanged,
    () =>
      typeof window === 'undefined'
        ? null
        : ((window as unknown as { __sentient_layout_override?: string[] })
            .__sentient_layout_override ?? null),
    () => null,
  );
  return override ?? contextOrder;
}

/** Internal: SSR-preloaded slot results for hydration-safe first render. */
export function useInitialSlots(): Record<string, SlotResult> {
  return useContext(AdaptiveContext).initialSlots;
}

/** Internal: SSR-decided persona carried alongside the client. */
export function useInitialPersona(): { persona: string; confidence: number } | null {
  return useContext(AdaptiveContext).initialPersona;
}

/** Internal: configured API base URL (devtools fetches /v1/explain against this, never a relative URL). */
export function useAdaptiveApiBaseUrl(): string {
  return useContext(AdaptiveContext).apiBaseUrl;
}
