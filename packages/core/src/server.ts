/**
 * Server-side helpers for SSR variant pre-loading.
 * Pure fetch — no DOM APIs. Safe in Node.js, Edge, and Deno runtimes.
 */
import { buildSessionUpsertPayload } from './session-meta.js';
import { LEGACY_SESSION_COOKIE_NAME, sessionCookieName } from './storage-key.js';
import {
  toWireSlot,
  baselineResultFor,
  baselineSlots,
  type SlotDeclInput,
  type SlotResult,
} from './slots.js';

import type { SlotConfigEntry } from './snapshot.js';
import type { RenderCaps } from './region-skeleton.js';
import type { SitePalette } from './blocks.js';

export type { SlotDeclInput, SlotResult, SlotConfigEntry, SitePalette };

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
  /**
   * Optional: this project's SECRET key (sk_...), read from a server-only env
   * var. When set, SSR calls also send it as `X-Sentient-Server-Key`, which
   * proves they come from your server: the API then holds them to your plan's
   * per-key limit instead of the 100 requests/min per-IP cap meant for
   * browsers — without it, all SSR traffic from one server address shares that
   * one cap. Never set this in code that ships to the browser; it is ignored
   * (and not sent) when `window` exists.
   */
  serverKey?: string;
  /** From `User-Agent` request header (Next.js `headers()`). */
  userAgent?: string;
  /** From `Referer` request header. */
  referer?: string;
  utmParams?: Record<string, string>;
  /**
   * Ad-platform click IDs (gclid, fbclid, ttclid, …) from the landing URL.
   * Derive both this and `utmParams` with `extractTrackedParams(searchParams)`
   * — the Referer header never carries the landing page's own query string, so
   * without these two fields SSR-minted sessions have no campaign attribution
   * until the client SDK hydrates.
   */
  clickIds?: Record<string, string>;
  /**
   * The landing page's path (no query string). With it the server can tell a
   * paid click to a product page, or a Shopify `/discount/CODE` link, from any
   * other arrival on the FIRST decision of the visit.
   */
  landingPath?: string;
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
   * Declared persona — the role your app already knows for this visitor
   * (e.g. from your auth context during SSR). Same contract as the client
   * option: must be a vocabulary key; unrecognized values are ignored
   * server-side. Never a user id or email.
   */
  persona?: string;
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

/** Header carrying `serverKey` (apps/api lib/rate-limit.ts SERVER_KEY_HEADER). */
export const SERVER_KEY_HEADER = 'X-Sentient-Server-Key';

/** Auth headers for an SSR call: the pk_, its Origin, and the optional server proof. */
function ssrHeaders(config: ServerAssignConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };
  if (config.origin) headers.Origin = config.origin;
  // A secret key must never leave a browser: if this module was bundled
  // client-side by mistake, drop it rather than send it.
  if (config.serverKey && typeof window === 'undefined') headers[SERVER_KEY_HEADER] = config.serverKey;
  return headers;
}

/** componentId → assigned variantId */
export type ServerAssignments = Record<string, string>;

type AssignResult = { variantId: string; assignmentTtlMs: number; unified?: true };

/** `preloadAssignmentsDetailed`'s answer: the assignments, plus the ids the
 *  server handed back as moved to the shared track (only when asked). */
export type ServerAssignmentsDetailed = { assignments: ServerAssignments; unified: string[] };

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
  return (await preloadAssignmentsDetailed(components, sessionId, config)).assignments;
}

/**
 * `preloadAssignments`, and also which components were moved onto the shared
 * track. With `opts.unified` each assign says the page can follow such a move:
 * a moved id is then not assigned (nothing is recorded for it) and comes back
 * in `unified`, for the page to render as a slot. Pass those ids to
 * `<AdaptiveProvider initialUnified>`. Without it a moved id is served its
 * frozen result read-only, as for any older SDK.
 */
export async function preloadAssignmentsDetailed(
  components: Array<{ id: string; variantIds: string[] }>,
  sessionId: string,
  config: ServerAssignConfig,
  opts?: { unified?: boolean },
): Promise<ServerAssignmentsDetailed> {
  // Opted-out visitor (DNT/GPC): render defaults, mint no session (audit P4).
  if (config.doNotTrack) return { assignments: {}, unified: [] };

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = ssrHeaders(config);

  // Session metadata must match the browser SDK so assign seeds variant_weights
  // under the same segment (not `unknown:unknown`).
  const sessionBody = {
    ...buildSessionUpsertPayload(sessionId, {
      userAgent: config.userAgent,
      referer: config.referer,
      utmParams: config.utmParams,
      clickIds: config.clickIds,
      appOrigin: config.origin,
      landingPath: config.landingPath,
    }),
    ...(config.persona ? { persona: config.persona } : {}),
  };

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
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ sessionId, componentId: id, variantIds, ...(opts?.unified ? { caps: { unified: true } } : {}) }),
        },
        timeoutMs,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error(`[SentientUI] preloadAssignments: assign failed for "${id}" (${res.status})`, body);
        return null;
      }
      const body = (await res.json()) as AssignResult;
      return { id, variantId: body.variantId, unified: opts?.unified === true && body.unified === true };
    }),
  );

  const assignments: ServerAssignments = {};
  const unified: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      // A moved id's variantId is only its declared baseline, not an
      // assignment: seeding it would settle the page on the frozen run.
      if (result.value.unified) unified.push(result.value.id);
      else assignments[result.value.id] = result.value.variantId;
    }
  }
  return { assignments, unified };
}

/**
 * Reads the Sentient session cookie from a Next.js `ReadonlyRequestCookies` object
 * (the return value of `cookies()` from `next/headers`), or any object with a
 * `get(name: string)` method. Returns null if the cookie is absent.
 *
 * Pass the project's `apiKey`: the client writes the per-project SUFFIXED name
 * (`sessionCookieName` — see storage-key.ts), so reading only the bare
 * `_snt_uid` missed the cookie on every SSR request for a returning visitor and
 * minted a fresh orphan session each page view (quota inflation, broken sticky
 * assignments and persona continuity). The bare name is still read as a
 * fallback for identities minted before namespacing.
 */
export function readSessionCookie(
  cookies: { get(name: string): { value: string } | undefined },
  apiKey?: string,
): string | null {
  return (
    (apiKey ? cookies.get(sessionCookieName(apiKey))?.value : undefined) ??
    cookies.get(LEGACY_SESSION_COOKIE_NAME)?.value ??
    null
  );
}

export type DecideResult = {
  layoutOrder: string[];
  assignments: Record<string, string>;
  /** Slot results keyed by slot id. Baseline-resolved when the API omits/fails them. */
  slots: Record<string, SlotResult>;
  persona: string;
  confidence: number;
  /** Registry mode only: content/ops/blocks for server-defined slots. */
  slotConfig?: Record<string, SlotConfigEntry>;
  /** Registry mode only: site palette for block rendering. */
  palette?: SitePalette;
  /** Registry mode only: site styles the served Redesign arms borrow. */
  vocabulary?: import('./style-vocabulary.js').StyleVocabulary;
  /** The visit's funnel stage, raw — projects with stages on, treated visitors
   *  only. Pass it through `exposedStage` before it reaches the page. */
  stage?: string;
  /** The visit's serving context. Never for the page. */
  context?: string;
  /** Requested components moved onto the shared track (only with
   *  `unifiedCaps`): not in `assignments`; render each as a slot. */
  unified?: string[];
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
    /** 'registry' serves the project's published slot_definitions as if declared
     *  (and is the only way slotConfig/palette come back). Default 'request'.
     *  Requires `registrySlotIds`: the `<Adaptive id>`s THIS page renders. */
    slotsFrom?: 'request' | 'registry';
    /**
     * Registry mode: decide only these published slot ids. Close-out turns
     * every slot decision into a trial without checking an exposure, so an
     * unscoped registry decide accrues trials — and session-level credit — for
     * every published slot on every page, including ones this page never
     * renders (CONTRACTS §2). Omitting it in registry mode is refused: the
     * call downgrades to request mode with one console.error, rather than
     * silently minting those trials.
     */
    registrySlotIds?: string[];
    /**
     * Registry mode: what each slot on this page can render (CONTRACTS §2).
     * The server has no DOM here, so no fingerprint is sent and a Rewrite arm
     * is assumed to match; a real mismatch is reported from the browser as
     * drift. Declare `forms: false` for slots without an `onFormSubmit`, or a
     * form arm can be drawn that this page will refuse. Default per slot:
     * `{ forms: true, compose: true, ops: false }`.
     */
    renderCaps?: Record<string, Omit<RenderCaps, 'fp'>>;
    /** The page renders a moved (unified) component on the shared track: such
     *  ids in `components` come back in `unified` instead of `assignments`,
     *  with nothing recorded. Without it they are served the frozen result. */
    unifiedCaps?: boolean;
  },
  sessionId: string,
  config: ServerAssignConfig,
): Promise<DecideResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const declaredSlots = params.slots ?? [];
  let registryIds: string[] | null = null;
  if (params.slotsFrom === 'registry') {
    if (Array.isArray(params.registrySlotIds)) {
      registryIds = params.registrySlotIds;
    } else {
      console.error(
        "[SentientUI] preloadDecisions: slotsFrom: 'registry' needs registrySlotIds (the <Adaptive id>s this page renders). " +
          'An unscoped registry decide records a trial for every published slot on every page; falling back to request mode.',
      );
    }
  }
  const fallback: DecideResult = {
    layoutOrder: params.sections ?? [],
    assignments: {},
    slots: baselineSlots(declaredSlots),
    persona: 'unknown',
    confidence: 0,
  };

  // Opted-out visitor (DNT/GPC): baseline layout/slots, mint no session (audit P4).
  if (config.doNotTrack) return fallback;

  const headers = ssrHeaders(config);

  const sessionBody = {
    ...buildSessionUpsertPayload(sessionId, {
      userAgent: config.userAgent,
      referer: config.referer,
      utmParams: config.utmParams,
      clickIds: config.clickIds,
      appOrigin: config.origin,
      landingPath: config.landingPath,
    }),
    ...(config.persona ? { persona: config.persona } : {}),
  };

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
          // bootstrap:false — editor goals and the section map are snippet
          // data the React SDK never reads. An EMPTY id list is meaningful
          // ("nothing published is on this page"): zero trials, still a decide.
          ...(registryIds !== null
            ? {
                slotsFrom: 'registry',
                registrySlotIds: registryIds,
                bootstrap: false,
                // Always sent, so the server knows this is an SDK that can
                // render Rewrite arms — no `render` field means legacy.
                render: Object.fromEntries(
                  // compose: true — the React SDK (the SSR consumer) renders
                  // Redesign trees since native generation phase 2.
                  // ops: false — nothing here applies `ops`. Without it an
                  // SSR'd <Adaptive id> matching a script-tag component was drawn
                  // its ops-only version, rendered the original, and booked a trial.
                  registryIds.map((id) => [id, params.renderCaps?.[id] ?? { forms: true, compose: true, ops: false }]),
                ),
              }
            : {}),
          ...(config.persona ? { persona: config.persona } : {}),
          ...(params.unifiedCaps ? { caps: { unified: true } } : {}),
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
      slotConfig?: Record<string, SlotConfigEntry>;
      palette?: SitePalette;
      vocabulary?: import('./style-vocabulary.js').StyleVocabulary;
      persona?: string;
      confidence?: number;
      stage?: unknown;
      context?: unknown;
      unified?: unknown;
    };

    const slots: Record<string, SlotResult> = {};
    for (const d of declaredSlots) {
      // `data.slots === undefined` ⇒ server predates slots: baseline, no retry.
      slots[d.id] = data.slots?.[d.id] ?? baselineResultFor(d);
    }
    // Registry mode returns slots the request never declared — union them in
    // (same rule as the browser client), or an SSR page gets results for none
    // of its registry slots.
    for (const [slotId, result] of Object.entries(data.slots ?? {})) {
      if (!(slotId in slots)) slots[slotId] = result;
    }

    // Plain-object guard only (readSnapshot's rule): the server total-validated
    // the config at publish; a deep re-validation here would just drift.
    const slotConfigOk =
      data.slotConfig !== undefined && typeof data.slotConfig === 'object' && data.slotConfig !== null && !Array.isArray(data.slotConfig);

    return {
      layoutOrder: data.layoutOrder ?? params.sections ?? [],
      assignments: data.assignments ?? {},
      slots,
      persona: data.persona ?? 'unknown',
      confidence: data.confidence ?? 0,
      ...(slotConfigOk ? { slotConfig: data.slotConfig } : {}),
      ...(data.palette ? { palette: data.palette } : {}),
      ...(data.vocabulary ? { vocabulary: data.vocabulary } : {}),
      ...(typeof data.stage === 'string' ? { stage: data.stage } : {}),
      ...(typeof data.context === 'string' ? { context: data.context } : {}),
      ...(params.unifiedCaps && Array.isArray(data.unified)
        ? { unified: data.unified.filter((id): id is string => typeof id === 'string') }
        : {}),
    };
  } catch (err) {
    console.error('[SentientUI] preloadDecisions: decide threw', err);
    return fallback;
  }
}

/**
 * Fixed namespace for server-goal ids. It is public (it ships in this file), so
 * it adds no secrecy: the id's uniqueness comes from the session id it hashes
 * (see trackServerGoal). Never change it: a retried delivery must map to the
 * same goal id.
 */
export const SERVER_GOAL_NAMESPACE = '3d8f5a21-7c64-4b19-8e0a-5f2c91d7b6e3';

/**
 * Pure-JS SHA-1 (FIPS 180-4) for runtimes without Web Crypto: Node 18 (our
 * engines floor is 18.18) has no unflagged `globalThis.crypto`, and without
 * this every server goal there would end 'failed'. @internal: exported for
 * the test vector only; not re-exported from the entry.
 */
export function sha1Fallback(data: Uint8Array): Uint8Array {
  const rotl = (x: number, n: number): number => (x << n) | (x >>> (32 - n));
  const len = data.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(data);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (len * 8) >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Array<number>(80);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20 ? [(b & c) | (~b & d), 0x5a827999]
        : i < 40 ? [b ^ c ^ d, 0x6ed9eba1]
        : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
        : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f! + e + k! + w[i]!) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((v, i) => ov.setUint32(i * 4, v >>> 0));
  return out;
}

/**
 * RFC-4122 v5 UUID (SHA-1 over namespace bytes + name), via Web Crypto so this
 * file stays free of `node:` imports and `Buffer` (it also hosts the SSR
 * helpers, which run on Edge and Deno). @internal: exported for the test vector.
 */
export async function uuidV5(name: string, namespace: string): Promise<string> {
  const hex = namespace.replace(/-/g, '');
  const nsBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) nsBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  input.set(nsBytes, 0);
  input.set(nameBytes, 16);
  const subtle = globalThis.crypto?.subtle;
  const h = (subtle ? new Uint8Array(await subtle.digest('SHA-1', input)) : sha1Fallback(input)).slice(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

// Pure-JS SHA-256 for the same Node-18 gap sha1Fallback covers (no global
// Web Crypto there, and this file takes no `node:` imports). @internal.
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256Fallback(data: Uint8Array): Uint8Array {
  const bitLen = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const pv = new DataView(padded.buffer);
  pv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  pv.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = pv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i]! + w[i]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0; h[5] = (h[5]! + f) | 0; h[6] = (h[6]! + g) | 0; h[7] = (h[7]! + hh) | 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  h.forEach((v, i) => ov.setUint32(i * 4, v));
  return out;
}

function hmacSha256Fallback(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha256Fallback(key) : key);
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = k[i]! ^ 0x36;
    outer[i] = k[i]! ^ 0x5c;
  }
  inner.set(msg, 64);
  outer.set(sha256Fallback(inner), 64);
  return sha256Fallback(outer);
}

/** HMAC-SHA256 as hex — Web Crypto when present, else the pure-JS fallback. */
async function hmacSha256Hex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = enc.encode(key);
  const m = enc.encode(msg);
  const subtle = globalThis.crypto?.subtle;
  const mac = subtle
    ? new Uint8Array(await subtle.sign('HMAC', await subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), m))
    : hmacSha256Fallback(k, m);
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verified identify: the `userHash` for `identify(userId, { userHash })`.
 * Compute it on YOUR server (it needs the secret key) and hand it to the page
 * with the user id — `<AdaptiveRoot userId>` from `@sentientui/react/next`
 * does both for you. Once a project sends verified identifies, only verified
 * bindings receive server goals by `userId` and carry a user's portrait
 * across devices: an unsigned identify is any browser's claim.
 *
 * The secret is derived from the secret key, so there is nothing new to
 * configure: `HMAC(sk, 'sentient-identity-v1')`, then `v1.<exp>.` + HMAC(that,
 * `${userId}.${exp}`) — the API stores the same derivation per server key.
 * Valid for `ttlSeconds` (default 24 h, at most 7 days).
 */
export async function signUserId(
  userId: string,
  serverKey: string,
  opts?: { ttlSeconds?: number; now?: number },
): Promise<string> {
  if (typeof window !== 'undefined') {
    console.error('[SentientUI] signUserId is server-only: it needs the secret key. Compute the hash on your server and pass it to identify().');
    return '';
  }
  // The expiry is signed in, so a hash read off a page stops verifying: sign
  // per render (AdaptiveRoot does), not once per user. The API refuses more
  // than 7 days.
  // Clamped to the API's 7-day maximum: a longer TTL would yield a hash that
  // is refused, i.e. an identify that silently stays unverified.
  const exp = Math.floor((opts?.now ?? Date.now()) / 1000) + Math.min(opts?.ttlSeconds ?? 86_400, 7 * 86_400);
  const secret = await hmacSha256Hex(serverKey, 'sentient-identity-v1');
  return `v1.${exp}.${await hmacSha256Hex(secret, `${userId}.${exp}`)}`;
}

const DEFAULT_GOAL_API_BASE = 'https://api.sentient-ui.com/v1';
const DEFAULT_GOAL_TIMEOUT_MS = 5000;

export type TrackServerGoalOptions = {
  /** Project SECRET key (sk_...), from a server-only env var. */
  serverKey: string;
  /** The visitor's session id: `readSessionCookie(cookies, apiKey)` in the same
   *  request, or the id you stored from `client.getVisitorId()`. Null/empty
   *  means nobody to credit: nothing is sent. */
  sessionId?: string | null;
  /** Your own user id, as passed to `client.identify()` in the browser — use it
   *  when the backend never sees our visitor id (a webhook, a job, a signup
   *  handled on another host). The API credits that user's most recently seen
   *  visit in the project; with no such visit nothing is recorded and this
   *  resolves 'skipped_no_visitor'. Ignored when `sessionId` is given. */
  userId?: string | null;
  /** Goal name, as defined in your project (e.g. 'purchase'). */
  name: string;
  /** Your own id for this conversion (order id, Stripe event id, user id).
   *  Calling again with the same session + name + dedupeKey counts once. */
  dedupeKey: string;
  value?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
  /** API base including `/v1`. Defaults to the hosted API. */
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  /** Give up after this many ms. Default 5000. */
  timeoutMs?: number;
};

/**
 * Records a conversion from your server (route handler, server action,
 * webhook). Never throws; resolves 'recorded', 'skipped_no_visitor' (no
 * session to credit, nothing sent) or 'failed'.
 *
 * Hand-rolling this (cookie, deterministic id, sk_ call) was the only way to
 * count a webhook-confirmed conversion, and few customers would get the dedupe
 * right: a random goal id per attempt counts a retried webhook twice. The id
 * here is derived from session + name + dedupeKey, so replays collapse
 * server-side; dedupeKey is also sent as externalId, which the API dedupes per
 * (project, goal name) on its own.
 */
export async function trackServerGoal(
  opts: TrackServerGoalOptions,
): Promise<'recorded' | 'skipped_no_visitor' | 'failed'> {
  // A secret key must never leave a browser (same rule as ssrHeaders).
  if (typeof window !== 'undefined') {
    console.error('[SentientUI] trackServerGoal is server-only: the secret key was not sent. Call it from a route handler, server action or webhook.');
    return 'failed';
  }
  const userId = opts.sessionId ? null : (opts.userId || null);
  if (!opts.sessionId && !userId) return 'skipped_no_visitor';
  // The id is derived from `${sessionId}:${name}:${dedupeKey}`, so a ':' in the
  // name would let ('a:b','c') and ('a','b:c') collide on one goal id and
  // silently merge two different conversions. Goal names never need one;
  // refuse it.
  if (opts.name.includes(':')) {
    console.error('[SentientUI] trackServerGoal: goal names cannot contain ":" (nothing was sent).');
    return 'failed';
  }
  const doFetch = opts.fetch ?? fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout'));
      }, opts.timeoutMs ?? DEFAULT_GOAL_TIMEOUT_MS);
    });
    // Started before the (async) id hash so the budget covers the whole call;
    // the no-op catch keeps an early expiry from being an unhandled rejection.
    timedOut.catch(() => undefined);
    // The session id is part of the hash because goal_events.goal_id is
    // UNIQUE across ALL projects (migration 060) and the insert is a bare ON
    // CONFLICT DO NOTHING: hashed from name + dedupeKey alone, two tenants that
    // both send ('purchase', order #1001) derived the same id, and the second
    // tenant's conversion was silently dropped while this call still returned
    // 'recorded'; anyone with a pk_ could also pre-burn a guessable order id.
    // The session id is an unguessable per-project visitor key, so the id is
    // now unique per tenant. Retry dedupe does not depend on it alone: the
    // dedupeKey also rides as externalId (unique per project + goal name).
    // A user id is NOT unguessable or unique across tenants ("42" exists in
    // every customer's database), so the userId path keys the hash on the
    // secret key too — per-project and never guessable, the property the
    // session id gave the hash above. Rotating the key changes the id; retry
    // dedupe still holds through externalId.
    const goalId = await uuidV5(
      userId === null
        ? `${opts.sessionId}:${opts.name}:${opts.dedupeKey}`
        : `user:${opts.serverKey}:${userId}:${opts.name}:${opts.dedupeKey}`,
      SERVER_GOAL_NAMESPACE,
    );
    // Raced as well as aborted: a fetch that ignores its signal must still
    // not hold the caller (a webhook handler) past the timeout.
    const res = await Promise.race([
      doFetch(`${(opts.apiBaseUrl ?? DEFAULT_GOAL_API_BASE).replace(/\/+$/, '')}/goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.serverKey}` },
        body: JSON.stringify({
          ...(userId === null ? { sessionId: opts.sessionId } : { userId }),
          name: opts.name,
          goalId,
          externalId: opts.dedupeKey,
          ...(opts.value !== undefined ? { value: opts.value } : {}),
          ...(opts.currency !== undefined ? { currency: opts.currency } : {}),
          ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
        }),
        signal: controller.signal,
      }),
      timedOut,
    ]);
    if (res.ok) return 'recorded';
    // 404 visitor_not_found: no visit carries that user id (never identified,
    // or erased) — nobody to credit, the same outcome as no sessionId.
    if (userId !== null && res.status === 404) {
      // The silent version of this was the whole debugging experience of a
      // missing identify: the call "worked" and no conversion ever appeared.
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[SentientUI] trackServerGoal: no visit is linked to userId "${userId}" yet, so "${opts.name}" was not recorded. Identify the visitor in the browser first (<AdaptiveRoot userId>, or identify(userId, { userHash })) — once a project signs its identifies, only signed visits count.`);
      }
      return 'skipped_no_visitor';
    }
    return 'failed';
  } catch {
    return 'failed';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
