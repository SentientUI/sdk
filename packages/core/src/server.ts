/**
 * Server-side helpers for SSR variant pre-loading.
 * Pure fetch — no DOM APIs. Safe in Node.js, Edge, and Deno runtimes.
 */
import { buildSessionUpsertPayload } from './session-meta.js';
import {
  toWireSlot,
  baselineResultFor,
  baselineSlots,
  type SlotDeclInput,
  type SlotResult,
} from './slots.js';

export type { SlotDeclInput, SlotResult };

export type ServerAssignConfig = {
  /** Public API key (pk_...). */
  apiKey: string;
  /**
   * Base URL of the Sentient API without trailing slash.
   * e.g. 'https://api.yourapp.com/v1'
   */
  baseUrl: string;
  /**
   * Browser origin of your app (e.g. `http://localhost:3001`). Required for `pk_`
   * keys — server-side fetch must send the same `Origin` the API allows.
   */
  origin?: string;
  /** From `User-Agent` request header (Next.js `headers()`). */
  userAgent?: string;
  /** From `Referer` request header. */
  referer?: string;
  utmParams?: Record<string, string>;
  /**
   * Set true when the request carries a tracking opt-out — `DNT: 1` or
   * `Sec-GPC: 1`. When set, the SSR helpers skip the session upsert and the
   * assign/decide call entirely: the page renders defaults/baseline and no
   * session row is minted for the visitor (audit P4). The client SDK already
   * no-ops for these visitors; this keeps the server from minting a session +
   * assignment on every page view before the client can.
   */
  doNotTrack?: boolean;
  /**
   * Milliseconds to wait for the API before returning default variants.
   * Prevents slow/cold API from blocking SSR. Defaults to 1000 — the hot path
   * is served from in-process caches and typically returns in well under
   * 150 ms. The full 1 s budget is only reached on a cold start or an API
   * geographically distant from your SSR host, after which defaults render
   * with no layout shift. Lower it if your API is co-located and warm.
   */
  timeoutMs?: number;
};

/** componentId → assigned variantId */
export type ServerAssignments = Record<string, string>;

type AssignResult = { variantId: string; assignmentTtlMs: number };

const DEFAULT_TIMEOUT_MS = 1000;

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Fetches variant assignments server-side for all listed components.
 * Returns a map suitable for passing as `initialAssignments` to `<AdaptiveProvider>`.
 *
 * Call from Next.js layout, Server Component, or getServerSideProps.
 *
 * @example
 * ```tsx
 * const assignments = await preloadAssignments(
 *   [
 *     { id: 'hero', variantIds: ['hero-a', 'hero-b'] },
 *     { id: 'cta',  variantIds: ['cta-short', 'cta-long'] },
 *   ],
 *   sessionId,           // read from cookies() or req.cookies
 *   { apiKey: process.env.NEXT_PUBLIC_SENTIENT_API_KEY!, baseUrl: 'https://api.sentient-ui.com/v1' },
 * );
 * return <AdaptiveProvider ... initialAssignments={assignments}>{children}</AdaptiveProvider>;
 * ```
 */
export async function preloadAssignments(
  components: Array<{ id: string; variantIds: string[] }>,
  sessionId: string,
  config: ServerAssignConfig,
): Promise<ServerAssignments> {
  // Opted-out visitor (DNT/GPC): render defaults, mint no session (audit P4).
  if (config.doNotTrack) return {};

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };
  if (config.origin) {
    headers.Origin = config.origin;
  }

  // Session metadata must match the browser SDK so assign seeds variant_weights
  // under the same segment (not `unknown:unknown`).
  const sessionBody = buildSessionUpsertPayload(sessionId, {
    userAgent: config.userAgent,
    referer: config.referer,
    utmParams: config.utmParams,
    appOrigin: config.origin,
  });

  try {
    const res = await fetchWithTimeout(
      `${config.baseUrl}/sessions`,
      { method: 'POST', headers, body: JSON.stringify(sessionBody) },
      timeoutMs,
    );
    if (res.status === 402) {
      console.warn(
        '[SentientUI] Session limit exceeded for this project. The bandit will stop learning until the limit resets. Upgrade at sentient-ui.com/pricing',
      );
    } else if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error(`[SentientUI] preloadAssignments: session upsert failed (${res.status})`, body);
    }
  } catch (err) {
    console.error('[SentientUI] preloadAssignments: session upsert threw', err);
  }

  const results = await Promise.allSettled(
    components.map(async ({ id, variantIds }) => {
      const res = await fetchWithTimeout(
        `${config.baseUrl}/assign`,
        { method: 'POST', headers, body: JSON.stringify({ sessionId, componentId: id, variantIds }) },
        timeoutMs,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error(`[SentientUI] preloadAssignments: assign failed for "${id}" (${res.status})`, body);
        return null;
      }
      const body = (await res.json()) as AssignResult;
      return { id, variantId: body.variantId };
    }),
  );

  const assignments: ServerAssignments = {};
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      assignments[result.value.id] = result.value.variantId;
    }
  }
  return assignments;
}

/**
 * Reads the Sentient session cookie from a Next.js `ReadonlyRequestCookies` object
 * (the return value of `cookies()` from `next/headers`), or any object with a
 * `get(name: string)` method. Returns null if the cookie is absent.
 */
export function readSessionCookie(
  cookies: { get(name: string): { value: string } | undefined },
): string | null {
  return cookies.get('_snt_uid')?.value ?? null;
}

export type DecideResult = {
  layoutOrder: string[];
  assignments: Record<string, string>;
  /** Slot results keyed by slot id. Baseline-resolved when the API omits/fails them. */
  slots: Record<string, SlotResult>;
  persona: string;
  confidence: number;
};

/**
 * Single-roundtrip SSR call returning layout order, component assignments,
 * and adaptive-slot results. Falls back to default section order + empty
 * assignments + baseline slots if the API is unavailable. A response without
 * a `slots` field means the server predates slots — every declared slot
 * resolves to its baseline (no retry).
 */
export async function preloadDecisions(
  params: {
    sections?: string[];
    components: Array<{ id: string; variantIds?: string[] }>;
    slots?: SlotDeclInput[];
  },
  sessionId: string,
  config: ServerAssignConfig,
): Promise<DecideResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const declaredSlots = params.slots ?? [];
  const fallback: DecideResult = {
    layoutOrder: params.sections ?? [],
    assignments: {},
    slots: baselineSlots(declaredSlots),
    persona: 'unknown',
    confidence: 0,
  };

  // Opted-out visitor (DNT/GPC): baseline layout/slots, mint no session (audit P4).
  if (config.doNotTrack) return fallback;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };
  if (config.origin) headers.Origin = config.origin;

  const sessionBody = buildSessionUpsertPayload(sessionId, {
    userAgent: config.userAgent,
    referer: config.referer,
    utmParams: config.utmParams,
    appOrigin: config.origin,
  });

  try {
    const sessionRes = await fetchWithTimeout(
      `${config.baseUrl}/sessions`,
      { method: 'POST', headers, body: JSON.stringify(sessionBody) },
      timeoutMs,
    );
    if (!sessionRes.ok) {
      const body = await sessionRes.json().catch(() => ({}));
      console.error(`[SentientUI] preloadDecisions: session upsert failed (${sessionRes.status})`, body);
    }
  } catch (err) {
    console.error('[SentientUI] preloadDecisions: session upsert threw', err);
  }

  try {
    const res = await fetchWithTimeout(
      `${config.baseUrl}/decide`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId,
          sections: (params.sections ?? []).map((id) => ({ id })),
          components: params.components,
          ...(declaredSlots.length > 0 ? { slots: declaredSlots.map(toWireSlot) } : {}),
        }),
      },
      timeoutMs,
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error(`[SentientUI] preloadDecisions: decide failed (${res.status})`, body);
      return fallback;
    }
    const data = (await res.json()) as {
      layoutOrder?: string[];
      assignments?: Record<string, string>;
      slots?: Record<string, SlotResult>;
      persona?: string;
      confidence?: number;
    };

    const slots: Record<string, SlotResult> = {};
    for (const d of declaredSlots) {
      // `data.slots === undefined` ⇒ server predates slots: baseline, no retry.
      slots[d.id] = data.slots?.[d.id] ?? baselineResultFor(d);
    }

    return {
      layoutOrder: data.layoutOrder ?? params.sections ?? [],
      assignments: data.assignments ?? {},
      slots,
      persona: data.persona ?? 'unknown',
      confidence: data.confidence ?? 0,
    };
  } catch (err) {
    console.error('[SentientUI] preloadDecisions: decide threw', err);
    return fallback;
  }
}
