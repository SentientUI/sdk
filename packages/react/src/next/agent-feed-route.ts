/**
 * `createAgentFeed` — a framework-standard Route Handler (Web `Request` →
 * `Response`) that serves the agent-readable feed via HTTP content negotiation:
 * `text/markdown` (Accept header or `.md` URL) → Markdown, otherwise JSON.
 *
 * This is the secondary channel of the agent-readable design — for agents that
 * *ask* (coding agents, agents the customer controls, future crawlers). The
 * primary channel is the server-rendered inline JSON-LD from `<AdaptiveRoot>`.
 *
 * Every fetch is reported to `onRead` (best-effort) so it can be logged to
 * `crawler_requests` and counted in the dashboard traffic breakdown.
 */
import { matchedAgentToken } from '@sentientui/core';
import { renderAgentMarkdown, type AgentFeed } from '../agent-feed.js';

export type AgentFeedReadEntry = {
  path: string;
  userAgent: string | null;
  botName: string | null;
};

export type AgentFeedRouteConfig = {
  /** Resolve the feed for a request (winning variants + layout + dev content). */
  getFeed: (request: Request) => Promise<AgentFeed> | AgentFeed;
  /** Best-effort per-fetch hook — log to `crawler_requests` here. Never awaited into the response. */
  onRead?: (entry: AgentFeedReadEntry) => void | Promise<void>;
};

function wantsMarkdown(url: URL, accept: string): boolean {
  return url.pathname.endsWith('.md') || accept.toLowerCase().includes('text/markdown');
}

export function createAgentFeed(
  config: AgentFeedRouteConfig,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const accept = request.headers.get('accept') ?? '';
    const userAgent = request.headers.get('user-agent');
    // Strip the .md/.json suffix so the feed path matches the page path.
    const path = url.pathname.replace(/\.(md|json)$/, '');

    if (config.onRead) {
      try {
        void Promise.resolve(
          config.onRead({ path, userAgent, botName: matchedAgentToken(userAgent ?? '') }),
        ).catch(() => {});
      } catch {
        /* logging must never break the response */
      }
    }

    const feed = await config.getFeed(request);

    if (wantsMarkdown(url, accept)) {
      return new Response(renderAgentMarkdown(feed), {
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      });
    }
    return new Response(JSON.stringify(feed), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };
}
