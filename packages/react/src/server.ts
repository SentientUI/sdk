/**
 * Server-only helpers for Next.js / SSR. No React or DOM APIs.
 */
import {
  preloadAssignments,
  readSessionCookie,
  type ServerAssignConfig,
  type ServerAssignments,
} from '@sentientui/core/server';

export { preloadAssignments, readSessionCookie };
export type { ServerAssignConfig, ServerAssignments };

/** Return value of `loadAdaptiveAssignments` — includes the session ID used for SSR. */
export type LoadAdaptiveAssignmentsResult = {
  assignments: ServerAssignments;
  /** The session ID used for SSR assignment. Pass as `ssrSessionId` to `<AdaptiveProvider>`. */
  sessionId: string;
};

export type LoadAdaptiveAssignmentsOptions = {
  /** Next.js `cookies()` return value, or any object with `get(name)`. */
  cookies: { get(name: string): { value: string } | undefined };
  apiKey: string;
  baseUrl: string;
  /** Used when `_snt_uid` is absent (e.g. first visit, many crawlers). */
  createSessionId?: () => string;
  /** Must match a value in the project's `allowed_origins` (e.g. `http://localhost:3001`). */
  origin?: string;
  /** From Next.js `headers().get('user-agent')` — aligns SSR segment with the client. */
  userAgent?: string;
  /** From Next.js `headers().get('referer')`. */
  referer?: string;
  /**
   * `utm_*` params from the landing URL. The Referer header never carries the
   * page's OWN query string, so without this the SSR-minted session has no
   * campaign attribution until the client SDK hydrates and re-upserts.
   * Derive with `extractTrackedParams(searchParams)` from `@sentientui/core/server`.
   */
  utmParams?: Record<string, string>;
  /** Ad-platform click IDs (gclid, fbclid, ttclid, …) from the landing URL — same derivation as `utmParams`. */
  clickIds?: Record<string, string>;
  /** Set true when the request carries `DNT: 1` or `Sec-GPC: 1` — skips the SSR session upsert + assignment so no session is minted for an opted-out visitor (audit P4). `AdaptiveRoot` sets this automatically from the request headers. */
  doNotTrack?: boolean;
  /** Milliseconds to wait for the API before returning default variants. Defaults to 1000 (typical decide is well under 150 ms; the full budget is only reached on a cold start or a distant API). */
  timeoutMs?: number;
  /**
   * Declared persona — the role your app already knows for this visitor (e.g.
   * from your auth context: 'admin', 'evaluator'). Must be a key in the
   * project's persona vocabulary; unrecognized values are ignored server-side.
   * Never a user id or email.
   */
  persona?: string;
};

function defaultSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `snt-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Fetches bandit assignments on the server for SEO-safe HTML.
 * Pass `assignments` as `initialAssignments` and `sessionId` as `ssrSessionId`
 * on `<AdaptiveProvider>` so the client adopts the same session on first visit.
 */
export async function loadAdaptiveAssignments(
  components: Array<{ id: string; variantIds: string[] }>,
  options: LoadAdaptiveAssignmentsOptions,
): Promise<LoadAdaptiveAssignmentsResult> {
  // apiKey is not optional here: the client writes the per-project suffixed
  // cookie, so an un-keyed read missed every returning visitor and minted a
  // fresh orphan session per SSR request (see readSessionCookie in core).
  const sessionId =
    readSessionCookie(options.cookies, options.apiKey) ??
    options.createSessionId?.() ??
    defaultSessionId();

  const assignments = await preloadAssignments(components, sessionId, {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    origin: options.origin,
    userAgent: options.userAgent,
    referer: options.referer,
    utmParams: options.utmParams,
    clickIds: options.clickIds,
    doNotTrack: options.doNotTrack,
    timeoutMs: options.timeoutMs,
    persona: options.persona,
  });

  return { assignments, sessionId };
}

export { preloadDecisions } from '@sentientui/core/server';
export type { DecideResult, SlotDeclInput, SlotResult } from '@sentientui/core/server';

/** Return value of `loadAdaptiveDecision` — includes the session ID used for SSR. */
export type LoadAdaptiveDecisionResult = import('@sentientui/core/server').DecideResult & {
  sessionId: string;
};

export type LoadAdaptiveDecisionOptions = LoadAdaptiveAssignmentsOptions & {
  /**
   * Section IDs in default order. Passed to /v1/decide as the candidate
   * layout. Optional since 0.13.0 — slot-only pages may omit it (at least
   * one of `sections`/`components`/`slots` must be non-empty).
   */
  sections?: string[];
  /** Components to assign in the same decide call. */
  components?: Array<{ id: string; variantIds?: string[] }>;
  /** Adaptive-slot declarations (useAdaptiveTokens / AdaptiveGroup) to decide server-side. */
  slots?: import('@sentientui/core/server').SlotDeclInput[];
};

/**
 * SSR helper for pages with a declared section layout and/or adaptive slots.
 * Calls `/v1/decide` instead of multiple `/v1/assign` round trips.
 * Pass `sessionId` as `ssrSessionId` on `<AdaptiveProvider>` so the client
 * adopts the same session on first visit.
 *
 * Keyless: with no valid `pk_` key this never fetches (no timeout burn).
 * Under the `development` export condition the decision is computed by the
 * deterministic local engine with the same sessionId the client will adopt —
 * server and client agree by construction. In production the engine resolves
 * to a stub and defaults are returned with one console.error.
 */
export async function loadAdaptiveDecision(
  options: LoadAdaptiveDecisionOptions,
): Promise<LoadAdaptiveDecisionResult> {
  const { preloadDecisions, readSessionCookie } = await import('@sentientui/core/server');

  // Keyed read — the client's cookie name is suffixed per project (see
  // loadAdaptiveAssignments above). Works for keyless too: with no pk_ key the
  // client writes the bare legacy name, which the un-suffixed read falls back to.
  const sessionId =
    readSessionCookie(options.cookies, options.apiKey) ??
    options.createSessionId?.() ??
    defaultSessionId();

  const keyValid = typeof options.apiKey === 'string' && options.apiKey.startsWith('pk_');
  if (!keyValid) {
    const fallback: LoadAdaptiveDecisionResult = {
      layoutOrder: options.sections ?? [],
      assignments: {},
      slots: {},
      persona: 'unknown',
      confidence: 0,
      sessionId,
    };
    try {
      const mod = (await import('@sentientui/core/local')) as unknown as {
        LOCAL_ENGINE_AVAILABLE: boolean;
        createLocalEngine(opts: { sessionId: string }): {
          decide(input: {
            sections?: string[];
            components?: Array<{ id: string; variantIds?: string[] }>;
            slots?: LoadAdaptiveDecisionOptions['slots'];
          }): {
            layoutOrder: string[] | null;
            assignments: Record<string, string>;
            slots: Record<string, string | Record<string, string>>;
            persona: string;
            confidence: number;
          };
        };
      };
      if (!mod.LOCAL_ENGINE_AVAILABLE) {
        // Pinned message — must byte-match PROD_KEYLESS_ERROR in @sentientui/core.
        console.error(
          '[sentient] No API key configured — nothing is being learned. Set NEXT_PUBLIC_SENTIENT_API_KEY or pass localMode: true for local development.',
        );
        return fallback;
      }
      const outcome = mod.createLocalEngine({ sessionId }).decide({
        sections: options.sections,
        components: options.components ?? [],
        slots: options.slots ?? [],
      });
      return {
        layoutOrder: outcome.layoutOrder ?? options.sections ?? [],
        assignments: outcome.assignments,
        slots: outcome.slots,
        persona: outcome.persona,
        confidence: outcome.confidence,
        sessionId,
      };
    } catch {
      return fallback;
    }
  }

  const result = await preloadDecisions(
    {
      sections: options.sections,
      components: options.components ?? [],
      slots: options.slots ?? [],
    },
    sessionId,
    {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      origin: options.origin,
      userAgent: options.userAgent,
      referer: options.referer,
      utmParams: options.utmParams,
      clickIds: options.clickIds,
      doNotTrack: options.doNotTrack,
      timeoutMs: options.timeoutMs,
      persona: options.persona,
    },
  );

  return { ...result, sessionId };
}
