// Fire-and-forget server-side log of a known AI-agent fetch to crawler_requests
// (via POST /v1/crawler-events). Machine telemetry — no cookie, no session.
// MUST NOT throw or be awaited into the render path.
export type AgentFetchLog = {
  baseUrl: string; // API base ending in /v1
  apiKey: string; // public pk_ key
  path: string;
  botName: string;
  userAgent?: string;
};

export function logAgentFetch(entry: AgentFetchLog, deps: { fetchImpl?: typeof fetch } = {}): void {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    void doFetch(`${entry.baseUrl}/crawler-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${entry.apiKey}` },
      body: JSON.stringify({
        path: entry.path,
        botName: entry.botName,
        userAgent: entry.userAgent ?? null,
        source: 'ssr',
      }),
    }).catch(() => {});
  } catch {
    /* never break render */
  }
}
