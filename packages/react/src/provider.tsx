'use client';

declare const process: { env?: { NODE_ENV?: string } } | undefined;

// `type JSX` from react, not the global namespace removed in @types/react@19
// (peers allow react >=18) — see adaptive-text.tsx.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from 'react';
import {
  deriveSessionSegment,
  init,
  type ConsentSource,
  type SentientClient,
  type SentientConfig,
  type SitePalette,
  type SlotConfigEntry,
  type StyleVocabulary,
  type SlotResult,
} from '@sentientui/core';
import type { SemanticType } from '@sentientui/core/engagement';
import { update as updateWeightsStore, type ComponentWeights } from './weights-store.js';
import { getPreviewMode, subscribePreview, createPreviewClient } from './preview-mode.js';
import { subscribeOverridesChanged } from './override-events.js';
import { publishDevtoolsConfig } from './devtools-config.js';
import { registerSections } from './devtools-registry.js';
import { isDevBuild } from './adaptive-shared.js';
import { SDK_IDENT } from './sdk-version.js';
import { maybeStartCellPreview } from './cell-preview.js';
import { maybeCaptureStyles } from './style-capture.js';

/**
 * Feeds browser globals into core's `deriveSessionSegment` so the cache key
 * used by `useAssignment` always matches the key `assign()` writes under.
 * Before this, the context defaulted to 'desktop:direct' while core used the
 * detected segment — a systematic cache miss for every integration that
 * didn't pass `sessionSegment` explicitly. The derivation itself lives in
 * core (audit REACT-14): a hand-mirrored `${device}:${source}` copy here
 * drifted independently of the key core writes, which is the cache-miss bug
 * all over again, one refactor later.
 */
function deriveDefaultSegment(): string {
  if (typeof window === 'undefined') return 'desktop:direct';
  try {
    return deriveSessionSegment({
      userAgent: navigator.userAgent ?? '',
      referer: document.referrer ?? '',
      appOrigin: window.location.origin,
    });
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
  initialSlotConfig: Record<string, SlotConfigEntry>;
  initialPalette: SitePalette | null;
  initialVocabulary: StyleVocabulary | null;
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
  initialSlotConfig: {},
  initialPalette: null,
  initialVocabulary: null,
  initialPersona: null,
  apiBaseUrl: DEFAULT_API_BASE_URL,
  debug: false,
});

export type AdaptiveProviderProps = {
  apiKey: string;
  /**
   * @deprecated Unused — the project's type is set in the dashboard. Safe to omit.
   * Still accepted (and forwarded to core, which ignores it) so existing code compiles.
   */
  context?: SentientConfig['context'];
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
   * @deprecated Use `clientOnly` on the component; the default behaviour renders
   * the first variant.
   *
   * When no `initialAssignments` exist for a component, `'first'` renders
   * `variantIds[0]` in server HTML (safe default for SEO); `'none'` renders
   * nothing until the client resolves. Still accepted with that exact behaviour
   * so existing trees don't change. Deprecated because it was a provider-wide
   * switch for a per-component decision (`clientOnly` already expresses it), and
   * it only ever reached `<Adaptive variants>` / `useAssignment` — `useAdaptive`
   * falls back to the first key regardless, and AdaptiveText, generated-version
   * `<Adaptive>` and slots never read it, so it read broader than it was.
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
   * @example // a supported consent platform (reads its API, events and cookie)
   * consentFrom="cookiebot"            // or 'onetrust' | 'cookieyes' | 'tcf' | 'google-consent-mode'
   * consentFrom={{ cmp: 'onetrust', group: 'C0004' }}
   * @example // any other CMP with a JS API
   * consentFrom={{ check: () => window.myCmp?.analytics === true, event: 'mycmp:changed' }}
   */
  consentFrom?: ConsentSource;
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
   * The section ids the app declares as reorderable, independent of any
   * decision. `AdaptiveRoot` forwards its `sections` prop here.
   *
   * Devtools reads this to offer layout previewing: a page whose decision was
   * gated by consent, or timed out, has no `initialLayoutOrder`, and registering
   * only that left the layout panel empty in exactly the situation you reach for
   * it — running the site locally before accepting a cookie banner.
   */
  declaredSections?: string[];
  /**
   * What each section IS, keyed by its `data-sentient-id`:
   * `{ about: 'trust', contact: 'cta' }`. Optional — sections are classified
   * from their content — but the classifier reads a section with little
   * signal-bearing copy (an "About us" band, a contact form) as `generic`, and
   * a `generic` section is ordered the same for every persona. Declare the
   * ones it gets wrong; any section with a `data-sentient-id` can appear here,
   * reorderable or not. Wins over legacy `data-sentient-type` markup.
   */
  sectionTypes?: Readonly<Partial<Record<string, SemanticType>>>;
  /**
   * SSR-preloaded slot results from `loadAdaptiveDecision()` (the `slots`
   * field of its result). Guarantees `useAdaptiveTokens`/`AdaptiveGroup`
   * render the decided arm in server HTML — zero flicker, hydration-safe.
   */
  initialSlots?: Record<string, SlotResult>;
  /**
   * SSR-preloaded registry slot config from `loadAdaptiveDecision()` (the
   * `slotConfig` field of its result, registry mode). Lets `AdaptiveSlot`
   * render server-authored content/blocks in server HTML — zero flicker.
   */
  initialSlotConfig?: Record<string, SlotConfigEntry>;
  /** SSR-preloaded site palette (`palette` field of `loadAdaptiveDecision()`'s
   *  registry-mode result) for block rendering. */
  initialPalette?: SitePalette;
  /** SSR-preloaded site styles (`vocabulary` field of `loadAdaptiveDecision()`'s
   *  registry-mode result) that served Redesign arms borrow. */
  initialVocabulary?: StyleVocabulary;
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
   * Declared persona — the role your app already knows for this visitor
   * (e.g. 'admin', 'evaluator'). Must be a key in the project's persona
   * vocabulary (dashboard → Settings → Personas); unrecognized values are
   * ignored server-side and surfaced in the dashboard. Served at full
   * confidence, overriding the inferred persona. Stable for the session —
   * like `country`, changing it after init is ignored (decisions are locked
   * per visit); remount the provider to apply a new value.
   */
  persona?: string;
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
  /**
   * CSP nonce for the <style> the SDK injects (the adaptation reveal), so a
   * nonce-based CSP needs no `style-src 'unsafe-inline'`. `AdaptiveRoot`
   * forwards its own `nonce`. Defaults to the nonce of a script on the page.
   */
  nonce?: string;
  children: ReactNode;
};

/** Once per page load — StrictMode and route-level providers remount. */
let warnedNoConsentGate = false;

/** Projects whose consent source has answered (non-null) in this page load.
 *  Module-level, not per mount: a remounted provider (route-level placement,
 *  a cached RSC payload on Back) or a changed consentFrom started over and fell
 *  back to AdaptiveRoot's stale request-time consent={true} (review R11 #1). */
const answeredThisPage = new Set<string>();

/**
 * Watches a {@link AdaptiveProviderProps.consentFrom} source and reports whether
 * it currently grants consent. Returns false (and subscribes to nothing) when no
 * source is configured.
 */
function useConsentSource(
  source: AdaptiveProviderProps['consentFrom'],
  apiKey: string,
  onRefused: () => void,
): { granted: boolean | null; refused: boolean } {
  const onRefusedRef = useRef(onRefused);
  onRefusedRef.current = onRefused;
  const [granted, setGranted] = useState<boolean | null>(null);
  const [refused, setRefused] = useState(false);

  // The source is usually an inline object literal, so its identity changes
  // every render. Read it through a ref and key the effect on a stable string,
  // otherwise the listener would be torn down and re-added on every render.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const key =
    source === undefined
      ? ''
      : typeof source === 'string'
        ? source
        : JSON.stringify({
            ...source,
            check: typeof (source as { check?: unknown }).check,
            refused: typeof (source as { refused?: unknown }).refused,
          });

  useEffect(() => {
    const s = sourceRef.current;
    if (s === undefined || typeof window === 'undefined') return;
    // Symmetric: every signal re-reads the source both ways, so a CMP
    // "withdrawn" decision later in the visit re-gates the SDK (the old shape
    // latched true and stopped listening). Payloads are never trusted.
    // The watcher is its own core entry, loaded only by pages that configure
    // a consent source; until it arrives the state stays "unknown" (gated,
    // or the server's read).
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import('@sentientui/core/consent').then(({ consentWatcher, forgetVisitor }) => {
      if (cancelled) return;
      const watcher = consentWatcher(
        // Both predicates through the ref: an inline `refused` closing over
        // state was frozen at the first render, so a later "no" never
        // forgot the visitor (review R7 #4).
        typeof s === 'object' && s.cmp === undefined && s.check
          ? {
              ...s,
              check: () => (sourceRef.current as { check: () => boolean }).check(),
              ...(s.refused ? { refused: () => (sourceRef.current as { refused?: () => boolean }).refused?.() === true } : {}),
            }
          : s,
      );
      // A recorded refusal forgets the visitor even when no tracking client
      // exists to destroy — a "no" given where the SDK wasn't watching (a CMP
      // settings page, checkout) otherwise left the 365-day id and the
      // decision snapshot in place for good (audit N2). refused() is false for
      // "not loaded yet" and "banner up", so a consented visitor is never
      // wiped by a slow CMP.
      let wasRefused = false;
      // Once the platform has answered in this page view, "no answer" again
      // (a custom banner's reset deleting its cookie) reads false — a pause.
      // As null it fell back to the server's request-time read, so a visitor
      // who withdrew under AdaptiveRoot's consent={true} was tracked again
      // under a fresh identity (grader N10-1). See answeredThisPage.
      const update = (): void => {
        // Never while the source reads granted (a custom `refused` that
        // disagrees with its own `check`): that would wipe a tracked visitor.
        const r = watcher.refused() && watcher.read() !== true;
        // On a change only: Consent Mode calls back on every dataLayer push.
        if (r && !wasRefused) {
          forgetVisitor(apiKey);
          onRefusedRef.current();
        }
        wasRefused = r;
        setRefused(r);
        const g = watcher.read();
        if (g !== null) answeredThisPage.add(apiKey);
        setGranted(g ?? (answeredThisPage.has(apiKey) ? false : null));
      };
      update();
      stop = watcher.subscribe(update);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [key, apiKey]);

  return { granted, refused };
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
  // On-site cell preview (dashboard "Preview on your site" link). No-ops
  // without both URL params; forces the previewed arm through the override
  // channel AdaptiveSlot already renders exposure-free.
  useEffect(() => {
    maybeStartCellPreview(props.apiBaseUrl);
    // Any editor-token session also samples the site's styles for Redesign
    // (React sites never load the snippet editor that does it elsewhere).
    maybeCaptureStyles(props.apiBaseUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When a consentFrom source is configured it owns the gate: start closed and
  // open only once the source grants. An explicit consent={true} (e.g. resolved
  // from the cookie on the server by AdaptiveRoot) short-circuits it, so a
  // returning visitor isn't gated waiting for a client-side re-read.
  // The browser source decides as soon as it knows (true OR false). Until then
  // (null: CMP not loaded yet) the server's read stands. The old
  // `props.consent === true || sourceGranted` let a server-side grant override
  // a mid-visit revocation for the rest of the page view.
  // Declared ahead of useConsentSource (which must call it): the refs it
  // clears are created further down.
  const dropHeldRef = useRef<() => void>(() => undefined);
  const source = useConsentSource(props.consentFrom, props.apiKey, () => dropHeldRef.current());
  // The server's read stands only until the browser source has answered in
  // this page load — also across remounts, before the watcher reloads.
  const consent = props.consentFrom
    ? (source.granted ?? (answeredThisPage.has(props.apiKey) ? false : props.consent === true))
    : props.consent;
  // Whether a `false` means "forget the visitor" or only "stop for now". An
  // explicit consent={false} is the site's own revocation; from a platform,
  // only a recorded refusal forgets — a consented visitor reopening the TCF
  // banner reads false too and was fully forgotten (review M2).
  const forgetOnFalse = props.consentFrom ? source.refused : true;
  const forgetRef = useRef(forgetOnFalse);
  forgetRef.current = forgetOnFalse;

  // The live client mirrored outside React state, so teardown can reach it
  // without a side effect inside a setState updater: React double-invokes
  // updaters in StrictMode dev (they must be pure), so `prev?.destroy()` inside
  // setClient ran twice — and could run during a render that never commits.
  const clientRef = useRef<SentientClient | null>(null);
  // Whether clientRef holds a TRACKING client (created with consent not false).
  // A revocation must forget that client's visitor; a pre-consent proxy has
  // nothing to forget.
  const trackingRef = useRef(false);
  // Conversions a gated client held (goal() before the consent source
  // answered), taken from it on teardown and handed to the next client: React
  // replaces the gated client on a grant instead of upgrading it in place, so
  // they were discarded with it (grader F2).
  const heldRef = useRef<Array<(c: SentientClient) => void>>([]);
  // A recorded refusal drops held conversions — ours and the gated client's —
  // so a later accept in the same page view can't send them (grader F-R1:
  // the effect is keyed on `consent`, which stays false from "unknown" to
  // "refused", so nothing else runs on the refusal).
  // The gated client is RELEASED, not just drained: draining left it holding,
  // so a goal fired after the refusal was held again and sent on a later
  // accept (grader R8 NEW-2). dispose() on a gated proxy drops its held calls,
  // answers its decides with null and holds nothing more; its read-only
  // winner (preConsentBehavior) keeps serving until the next consent change.
  // Latched too, until the next grant: a gated client created AFTER the
  // refusal — the re-init when a tracked visitor refuses, or the /graph
  // client landing after a boot-time refusal — was never released, so its
  // held goals reached the tracking client on a later accept (grader R9-1).
  const refusedRef = useRef(false);
  dropHeldRef.current = () => {
    heldRef.current = [];
    refusedRef.current = true;
    const c = clientRef.current;
    if (c?.gated) c.dispose();
    else c?.takeHeld?.();
  };

  useEffect(() => {
    // Revocation (a tracking client → consent false): forget the visitor —
    // identity cookie, assignment cache, decision snapshot, retry buckets —
    // via the ref, in the effect body (see clientRef above). This used to run
    // only without preConsentBehavior; with 'statistical_winner' the previous
    // run's cleanup merely dispose()d, so a withdrawn visitor kept the 365-day
    // cookie and their snapshot re-personalized the next page load.
    // (Only a forgetting revocation destroys; a pause was already disposed by
    // the previous run's cleanup, which keeps the identity.)
    if (forgetRef.current && consent === false) heldRef.current = [];
    if (consent === false && trackingRef.current) {
      if (forgetRef.current) clientRef.current?.destroy();
      clientRef.current = null;
      trackingRef.current = false;
    }
    if (consent === false && !props.preConsentBehavior) {
      if (forgetRef.current) clientRef.current?.destroy();
      clientRef.current = null;
      setClient(null);
      return;
    }
    const tracking = consent !== false;
    if (tracking) refusedRef.current = false;
    // A gated client born after a refusal is released at once (see refusedRef).
    const adopt = (c: SentientClient): void => {
      if (!tracking && refusedRef.current && c.gated) c.dispose();
    };

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
      persona: props.persona,
      localMode: props.localMode,
      initialSlots: props.initialSlots,
      initialSlotConfig: props.initialSlotConfig,
      initialPalette: props.initialPalette,
      initialVocabulary: props.initialVocabulary,
      initialPersona: props.initialPersona,
      ingestUrl: props.apiBaseUrl ? `${props.apiBaseUrl.replace(/\/$/, '')}/events` : undefined,
      nonce: props.nonce,
      // Declare which SDK (and which release) is driving this client, so the
      // dashboard can tell the project when it is running an old one. A React
      // install cannot self-update the way the snippet's CDN tag does, so this
      // nudge is the only update path there is.
      ...(SDK_IDENT ? { sdk: SDK_IDENT } : {}),
    };

    // Track the client created by this effect run so cleanup destroys exactly
    // the right one, and so a late-resolving dynamic import can bail if the
    // effect was already torn down (unmount / consent change).
    let cancelled = false;
    let created: SentientClient | null = null;
    let stopEngagement: (() => void) | null = null;

    // Engagement capture (default ON): per-section dwell/scroll + semantic
    // section registration, lazy-loaded so the lean bundle stays lean. Only for
    // a TRACKING client: with preConsentBehavior a gated visitor still gets a
    // (pre-consent proxy) client, and capture used to start on it — POSTing
    // /v1/section-map and attaching collectors while consent was false. The
    // capture module re-checks DNT internally.
    // Replay held conversions: sent by a tracking client, re-held by a gated one.
    // Each in its own task, like core's replay: one task would put them in
    // one latch window and collapse repeat conversions into one.
    const handOff = (c: SentientClient): void => {
      for (const call of heldRef.current.splice(0)) {
        setTimeout(() => {
          // Replaced before this task ran (unmount, another consent flip):
          // back into the stash for the next client, never into a disposed
          // one's dead queue (review R7 #6).
          if (clientRef.current !== c) {
            // …unless a refusal landed in between: it dropped the stash,
            // and pushing back revived the goal for a later accept
            // (review R10 #2).
            if (!refusedRef.current) heldRef.current.push(call);
            return;
          }
          try {
            call(c);
          } catch {
            /* one bad call never blocks the rest */
          }
        }, 0);
      }
    };

    const startEngagement = (c: SentientClient): void => {
      if (props.engagement === false || !tracking) return;
      void import('@sentientui/core/engagement').then(({ startEngagementCapture }) => {
        if (cancelled) return;
        stopEngagement = startEngagementCapture(c, {
          apiKey: props.apiKey,
          sectionTypes: props.sectionTypes,
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
        created = initGraph({
          ...config,
          graph: true,
          captureDomText: props.captureDomText === true,
          sectionTypes: props.sectionTypes,
        });
        adopt(created);
        clientRef.current = created;
        trackingRef.current = tracking;
        handOff(created);
        setClient(created);
        startEngagement(created);
      });
    } else {
      created = init(config);
      adopt(created);
      clientRef.current = created;
      trackingRef.current = tracking;
      handOff(created);
      setClient(created);
      startEngagement(created);
    }

    return () => {
      cancelled = true;
      stopEngagement?.();
      heldRef.current = heldRef.current.concat(created?.takeHeld?.() ?? []);
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
    // Optional since `context` was deprecated: undefined → undefined compares
    // equal under Object.is, so omitting it never trips the warning below.
    context: SentientConfig['context'] | undefined;
    country: string | undefined;
    persona: string | undefined;
    apiBaseUrl: string;
  } | null>(null);
  useEffect(() => {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') return;
    const current = { apiKey: props.apiKey, context: props.context, country: props.country, persona: props.persona, apiBaseUrl };
    const prev = frozenConfigRef.current;
    frozenConfigRef.current = current;
    if (prev === null) return; // first run: capture the frozen baseline, nothing to compare
    for (const key of ['apiKey', 'context', 'country', 'persona', 'apiBaseUrl'] as const) {
      if (!Object.is(prev[key], current[key])) {
        console.warn(
          `[sentient] AdaptiveProvider: \`${key}\` changed after initialisation, but the SDK client is stable for the session and only re-inits on \`consent\` — the new value is ignored. Remount the provider (e.g. via a changing \`key\` prop) to apply it.`,
        );
      }
    }
  }, [props.apiKey, props.context, props.country, props.persona, apiBaseUrl]);

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

  // Sections registry for devtools /v1/explain + local simulation. The decided
  // order wins when there is one (it is what the page is actually rendering);
  // the declared list is the fallback so the layout panel still knows what is
  // reorderable when no decision arrived.
  useEffect(() => {
    const decided = props.initialLayoutOrder;
    if (decided && decided.length > 0) {
      registerSections(decided);
      return;
    }
    if (props.declaredSections && props.declaredSections.length > 0) {
      registerSections(props.declaredSections);
    }
  }, [props.initialLayoutOrder, props.declaredSections]);

  // Dev-only: tracking is on by default, so an install that never wires a
  // consent gate tracks EU visitors from the first paint without anyone
  // having decided that (audit S6). Say so once, with the one-line fix.
  useEffect(() => {
    if (!isDevBuild() || props.consent !== undefined || props.consentFrom !== undefined) return;
    if (warnedNoConsentGate) return;
    warnedNoConsentGate = true;
    console.warn(
      '[SentientUI] No consent gate: every visitor is tracked from first paint. Pass consentFrom="<your CMP>" ' +
        '(or consent={true} to silence). https://sentient-ui.com/docs#consent',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dev-only: a declared section with no `data-sentient-id="<id>"` element is
  // invisible to the DOM graph scanner, so the server never learns its semantic
  // type and every persona gets the identity order — the layout looks "on" but
  // can never personalize (found on a real site 2026-09-05: nine declared
  // sections, zero graph rows, one bandit arm). Warn once with the exact fix
  // rather than leaving the integration silently inert.
  useEffect(() => {
    if (!isDevBuild()) return;
    const declared = props.declaredSections;
    if (!declared || declared.length === 0 || typeof document === 'undefined') return;
    const present = new Set(
      Array.from(document.querySelectorAll('[data-sentient-id]'), (el) =>
        el.getAttribute('data-sentient-id'),
      ),
    );
    const missing = declared.filter((id) => !present.has(id));
    if (missing.length > 0) {
      console.warn(
        `[SentientUI] Declared section${missing.length > 1 ? 's' : ''} ${missing
          .map((id) => `"${id}"`)
          .join(', ')} ${missing.length > 1 ? 'have' : 'has'} no matching ` +
          'data-sentient-id element, so the layout engine cannot learn what ' +
          'they are and will serve the same order to every persona. Add ' +
          'data-sentient-id="<sectionId>" to each section\'s element.',
      );
    }
  }, [props.declaredSections]);

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
      initialSlotConfig: props.initialSlotConfig ?? {},
      initialPalette: props.initialPalette ?? null,
      initialVocabulary: props.initialVocabulary ?? null,
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
      props.initialSlotConfig,
      props.initialPalette,
      props.initialVocabulary,
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

/** The `device:source` segment this provider decides and caches under —
 *  the SSR value when one was passed, else derived once per mount. */
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

/** Internal: SSR-preloaded registry slot config for hydration-safe AdaptiveSlot. */
export function useInitialSlotConfig(): Record<string, SlotConfigEntry> {
  return useContext(AdaptiveContext).initialSlotConfig;
}

/** Internal: SSR-preloaded site palette for block rendering. */
export function useInitialPalette(): SitePalette | null {
  return useContext(AdaptiveContext).initialPalette;
}

/** Internal: SSR-preloaded site styles for Redesign rendering. */
export function useInitialVocabulary(): StyleVocabulary | null {
  return useContext(AdaptiveContext).initialVocabulary;
}

/** Internal: configured API base URL (devtools fetches /v1/explain against this, never a relative URL). */
export function useAdaptiveApiBaseUrl(): string {
  return useContext(AdaptiveContext).apiBaseUrl;
}
