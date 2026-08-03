/**
 * `sentientAgentMiddleware` — additive-discovery middleware. Detects known AI
 * crawler / agent user-agents on page requests and reports them so they can be
 * logged to `crawler_requests` (the only way to observe passive crawlers, which
 * run no JS and never create a session). It NEVER changes the response — the
 * caller composes it into their Next.js middleware and returns `NextResponse.next()`.
 *
 *   export async function middleware(request: NextRequest) {
 *     await logCrawler(request);       // sentientAgentMiddleware instance
 *     return NextResponse.next();
 *   }
 */
import { matchedAgentToken } from '@sentientui/core';

export type CrawlerRequestEntry = {
  path: string;
  userAgent: string | null;
  botName: string;
};

export type SentientAgentMiddlewareConfig = {
  /** Best-effort sink — persist to `crawler_requests` here. Failures are swallowed. */
  onCrawler: (entry: CrawlerRequestEntry) => void | Promise<void>;
};

export function sentientAgentMiddleware(
  config: SentientAgentMiddlewareConfig,
): (request: Request) => Promise<boolean> {
  return async (request: Request): Promise<boolean> => {
    const userAgent = request.headers.get('user-agent');
    const botName = matchedAgentToken(userAgent ?? '');
    if (!botName) return false;

    try {
      const path = new URL(request.url).pathname;
      await Promise.resolve(config.onCrawler({ path, userAgent, botName })).catch(() => {});
    } catch {
      /* detection/logging must never break the request */
    }
    return true;
  };
}
