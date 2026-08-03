/** Session metadata helpers (browser + Node). No DOM APIs. */

/**
 * Known AI-agent / crawler user-agent tokens. Matched case-insensitively as
 * substrings. This is maintained data — bot lists move monthly. Used both to
 * flag automation on sessions (agentic browsers that leak a token) and by the
 * server middleware / agent-feed route to identify crawler HTTP reads.
 */
export const agentUaList: readonly string[] = [
  'GPTBot',
  'ChatGPT-User',
  'OAI-SearchBot',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'Meta-ExternalAgent',
  'Bytespider',
  'CCBot',
  'Amazonbot',
  'cohere-ai',
  'Diffbot',
];

/** True when the user-agent contains a known AI-agent / crawler token. */
export function uaTokenMatch(userAgent: string): boolean {
  return matchedAgentToken(userAgent) !== null;
}

/** The first known agent token found in the user-agent, or null. */
export function matchedAgentToken(userAgent: string): string | null {
  if (!userAgent) return null;
  const s = userAgent.toLowerCase();
  return agentUaList.find((token) => s.includes(token.toLowerCase())) ?? null;
}

/**
 * Purpose category for an agent fetch, inferred from its published user-agent:
 *  - `user`     — a person asked an assistant to read the page, live (…-User UAs)
 *  - `search`   — indexing for an AI answer engine (…-SearchBot / SearchBot)
 *  - `training` — model-training crawl (GPTBot, ClaudeBot, CCBot, …)
 *  - `other`    — not clearly AI, or an unknown/new token
 */
export type AgentIntent = 'user' | 'search' | 'training' | 'other';

/** Intent per agent token. Maintained beside `agentUaList` — when you add or
 *  rename a token above, set its intent here (a unit test enforces coverage). */
export const AGENT_INTENTS: Record<string, AgentIntent> = {
  'GPTBot': 'training',
  'ChatGPT-User': 'user',
  'OAI-SearchBot': 'search',
  'ClaudeBot': 'training',
  'Claude-User': 'user',
  'Claude-SearchBot': 'search',
  'PerplexityBot': 'search',
  'Perplexity-User': 'user',
  'Google-Extended': 'training',
  'Applebot-Extended': 'training',
  'Meta-ExternalAgent': 'training',
  'Bytespider': 'training',
  'CCBot': 'training',
  'Amazonbot': 'other',
  'cohere-ai': 'training',
  'Diffbot': 'other',
};

/** Intent for a matched bot token (case-insensitive); `other` for null/unknown. */
export function agentIntent(botName: string | null): AgentIntent {
  if (!botName) return 'other';
  const hit = agentUaList.find((t) => t.toLowerCase() === botName.toLowerCase());
  return (hit && AGENT_INTENTS[hit]) || 'other';
}

/** `agentUaList` grouped by intent — the "which crawlers do you classify?" reference. */
export function classifiedAgents(): Record<AgentIntent, string[]> {
  const out: Record<AgentIntent, string[]> = { user: [], search: [], training: [], other: [] };
  for (const t of agentUaList) out[AGENT_INTENTS[t] ?? 'other'].push(t);
  return out;
}

export function detectDeviceClass(userAgent: string): string {
  const s = userAgent.toLowerCase();
  if (/ipad|tablet|playbook|kindle|silk/.test(s)) return 'tablet';
  if (/mobi|iphone|ipod|android.*mobile|phone/.test(s)) return 'mobile';
  return 'desktop';
}

export function detectTrafficSource(referrer: string, appOrigin?: string): string {
  if (!referrer) return 'direct';
  try {
    const refUrl = new URL(referrer);
    if (appOrigin) {
      try {
        if (new URL(appOrigin).host === refUrl.host) return 'direct';
      } catch {
        /* ignore invalid appOrigin */
      }
    }
    const host = refUrl.hostname.toLowerCase();
    if (/(^|\.)(google|bing|duckduckgo|yahoo)\./.test(host)) return 'search';
    // Anchor to the registrable domain (exact host or a subdomain of it) so
    // hosts like `x.company.com`, `t.company.io` or `linkedinsights.com` are not
    // misclassified as social by an unbounded substring match.
    if (/(^|\.)(twitter\.com|x\.com|facebook\.com|linkedin\.com|reddit\.com|t\.co)$/.test(host)) return 'social';
    return 'referral';
  } catch {
    return 'direct';
  }
}

export function referrerDomainFromReferer(referrer: string): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname;
  } catch {
    return null;
  }
}

export function detectTimeOfDay(d: Date): string {
  const h = d.getHours();
  if (h < 6) return 'night';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

export type SessionUpsertPayload = {
  sessionId: string;
  ephemeral: boolean;
  utmParams: Record<string, string>;
  deviceClass: string;
  trafficSource: string;
  referrerDomain: string | null;
  timeOfDay: string;
  dayOfWeek: string;
  /**
   * True when this session is likely driven by automation — either
   * `navigator.webdriver` was set, or the user-agent carried a known agent
   * token. Probabilistic: a flag for metrics + bandit exclusion, never a gate.
   */
  automation: boolean;
};

/** Bandit segment key: `<device_class>:<traffic_source>`. */
export function deriveSessionSegment(opts?: {
  userAgent?: string;
  referer?: string;
  appOrigin?: string;
}): string {
  const body = buildSessionUpsertPayload('__segment__', opts);
  return `${body.deviceClass}:${body.trafficSource}`;
}

/**
 * Builds a session upsert body aligned with the browser SDK so SSR assign uses
 * the same segment key (`device:source`) as the client after hydration.
 */
export function buildSessionUpsertPayload(
  sessionId: string,
  opts?: {
    userAgent?: string;
    referer?: string;
    appOrigin?: string;
    utmParams?: Record<string, string>;
    now?: Date;
    /** `navigator.webdriver` value from the browser, when available. */
    webdriver?: boolean;
  },
): SessionUpsertPayload {
  const ua = opts?.userAgent?.trim() ?? '';
  const referer = opts?.referer?.trim() ?? '';
  const now = opts?.now ?? new Date();
  return {
    sessionId,
    ephemeral: false,
    utmParams: opts?.utmParams ?? {},
    deviceClass: ua ? detectDeviceClass(ua) : 'desktop',
    trafficSource: referer
      ? detectTrafficSource(referer, opts?.appOrigin)
      : 'direct',
    referrerDomain: referrerDomainFromReferer(referer),
    timeOfDay: detectTimeOfDay(now),
    dayOfWeek: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()] ?? 'sun',
    automation: opts?.webdriver === true || uaTokenMatch(ua),
  };
}
