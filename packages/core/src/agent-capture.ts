// Server-side capture of AI-assistant fetches, for any framework.
// Spec: docs/superpowers/specs/2026-09-23-server-side-agent-capture-design.md §4.1
//
// Assistants that fetch a page without running JavaScript (ChatGPT-User,
// Claude-User, Perplexity-User, GPTBot, …) never execute the snippet or the
// React SDK, so only the server that answered can see them. Until this, only
// Next.js AdaptiveRoot logged them; every other site read "no AI traffic",
// which is wrong rather than empty.
//
// OBSERVATION ONLY. Nothing here may change a response based on the user
// agent: that is cloaking, and SentientUI never claims to adapt serving to
// agents. These functions return nothing a caller could branch on except
// "did this look like an agent", and log to crawler_requests — never to
// sessions, never to training, never to billing.

import { matchedAgentToken } from './session-meta.js';

const DEFAULT_API_BASE_URL = 'https://api.sentient-ui.com/v1';

export type AgentCaptureOptions = {
  /** Your public `pk_` key — the same one the snippet uses. */
  apiKey: string;
  /** API base ending in `/v1`. Defaults to the hosted API. */
  baseUrl?: string;
  /** Which capture path saw the fetch. Shown per row on the dashboard. */
  source?: 'middleware' | 'edge' | 'ssr';
  /**
   * REQUIRED on edge runtimes (Vercel Routing Middleware, Cloudflare Workers,
   * Netlify Edge): they cancel outstanding work once the response is
   * returned, so a fire-and-forget request without it is silently dropped.
   * Pass the platform's `waitUntil` (`ctx.waitUntil.bind(ctx)` on Workers,
   * `waitUntil` from `@vercel/functions`). Node servers do not need it.
   */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
};

/** The minimum of a request both the Fetch API `Request` and hand-rolled
 *  objects satisfy. */
export type CapturableRequest = {
  url: string;
  headers: { get(name: string): string | null };
};

/** Pathname only: a query string can carry tokens, emails or campaign ids. */
function pathOf(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname || '/';
  } catch {
    return url.split(/[?#]/, 1)[0] || '/';
  }
}

/**
 * Low-level sender: posts one agent fetch to `/v1/crawler-events`. Never
 * throws, never blocks. The API re-derives the agent from `userAgent`
 * itself, so `botName` is advisory.
 */
export function postAgentFetch(
  entry: { path: string; userAgent: string; botName: string },
  opts: AgentCaptureOptions,
): void {
  const doFetch = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!doFetch || !opts.apiKey) return;
  try {
    const p = doFetch(`${opts.baseUrl ?? DEFAULT_API_BASE_URL}/crawler-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        path: entry.path,
        botName: entry.botName,
        userAgent: entry.userAgent,
        source: opts.source ?? 'middleware',
      }),
    }).catch(() => undefined);
    opts.waitUntil?.(p);
  } catch {
    /* capture must never break the page it is observing */
  }
}

/**
 * Log this request if its user agent is a known AI assistant or crawler.
 * Works with a Fetch API `Request` (edge runtimes, Hono, Remix / React
 * Router, Astro, SvelteKit) or anything with `url` + `headers.get`.
 *
 * Returns whether the request matched, so a caller can skip its own work;
 * it must NOT be used to serve anything different. Non-matching requests —
 * nearly all of them — make no network call.
 */
export function captureAgentRequest(req: CapturableRequest, opts: AgentCaptureOptions): boolean {
  let userAgent = '';
  try {
    userAgent = req.headers.get('user-agent') ?? '';
  } catch {
    return false;
  }
  const botName = matchedAgentToken(userAgent);
  if (!botName) return false;
  postAgentFetch({ path: pathOf(req.url), userAgent, botName }, opts);
  return true;
}

type ConnectRequest = {
  url?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
};

/**
 * Connect-style middleware (Express, Nitro / Nuxt on Node, Fastify via
 * middie, any `(req, res, next)` stack). Calls `next()` synchronously and
 * logs in the background; it never touches the response.
 */
export function sentientAgentMiddleware(
  opts: Omit<AgentCaptureOptions, 'waitUntil' | 'source'>,
): (req: ConnectRequest, res: unknown, next: (err?: unknown) => void) => void {
  return (req, _res, next) => {
    try {
      const raw = req.headers['user-agent'];
      const ua = Array.isArray(raw) ? raw[0] ?? '' : raw ?? '';
      captureAgentRequest(
        { url: req.originalUrl ?? req.url ?? '/', headers: { get: (n) => (n.toLowerCase() === 'user-agent' ? ua : null) } },
        { ...opts, source: 'middleware' },
      );
    } catch {
      /* never block the request */
    }
    next();
  };
}
