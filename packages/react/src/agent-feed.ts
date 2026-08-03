/**
 * Agent-readable content feed. Merges SDK-known data (winning variants, layout
 * order) with developer-supplied page content, and renders it either as a
 * server-rendered inline JSON-LD block (read by passive AI crawlers, which do
 * not run JS) or as Markdown (for agents that content-negotiate `text/markdown`).
 *
 * No React or DOM APIs — safe to import in server components, route handlers,
 * and middleware.
 */

export type AgentBlock = {
  /** Component ID. */
  id: string;
  /** Winning variant ID currently served. */
  variant: string;
  /** Agent-readable data attached to the served variant, if any. */
  content?: unknown;
};

export type AgentFeed = {
  page: string;
  title?: string;
  summary?: string;
  layoutOrder?: string[];
  blocks: AgentBlock[];
  /** Developer-supplied extra fields (products, specs, arbitrary JSON). */
  [key: string]: unknown;
};

/** Fields the SDK owns — developer content can never overwrite these. */
const RESERVED_FIELDS = ['page', 'blocks', 'layoutOrder'] as const;

const registry = new Map<string, Record<string, unknown>>();

/**
 * Register page-level structured content the SDK can't infer (title, summary,
 * product fields, arbitrary JSON), keyed by page path. Call at module load.
 */
export function defineAgentContent(page: string, content: Record<string, unknown>): void {
  registry.set(page, content);
}

/** Look up registered content for a page. */
export function getAgentContent(page: string): Record<string, unknown> | undefined {
  return registry.get(page);
}

/** Clear the registry — intended for tests. */
export function clearAgentContent(): void {
  registry.clear();
}

/**
 * Merge SDK-known data with developer-supplied content into a single feed.
 * Developer content fills in title/summary/etc. but can never overwrite the
 * SDK-authoritative fields (`page`, `blocks`, `layoutOrder`).
 */
export function buildAgentFeed(input: {
  page: string;
  blocks: AgentBlock[];
  layoutOrder?: string[];
  content?: Record<string, unknown>;
}): AgentFeed {
  const supplied = input.content ?? getAgentContent(input.page) ?? {};
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(supplied)) {
    if (!(RESERVED_FIELDS as readonly string[]).includes(k)) safe[k] = v;
  }
  const feed: AgentFeed = {
    ...safe,
    page: input.page,
    blocks: input.blocks,
  };
  if (input.layoutOrder) feed.layoutOrder = input.layoutOrder;
  return feed;
}

/**
 * Render the feed as a server-rendered inline JSON-LD `<script>` string. `<` is
 * escaped to `<` so embedded content cannot break out of the script
 * element. MUST be emitted on the server — passive crawlers never run client JS.
 */
export function renderAgentJsonLd(feed: AgentFeed): string {
  return `<script type="application/ld+json">${renderAgentJsonLdBody(feed)}</script>`;
}

/**
 * The escaped JSON-LD body only (no `<script>` wrapper). For React server
 * components, inject via `<script type="application/ld+json"
 * dangerouslySetInnerHTML={{ __html: renderAgentJsonLdBody(feed) }} />`.
 */
export function renderAgentJsonLdBody(feed: AgentFeed): string {
  return JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebPage', ...feed })
    .replace(/</g, '\\u003c');
}

/** Render the feed as Markdown for agents that negotiate `text/markdown`. */
export function renderAgentMarkdown(feed: AgentFeed): string {
  const lines: string[] = [];
  if (feed.title) lines.push(`# ${feed.title}`, '');
  if (feed.summary) lines.push(String(feed.summary), '');

  for (const [k, v] of Object.entries(feed)) {
    if (['page', 'title', 'summary', 'blocks', 'layoutOrder'].includes(k)) continue;
    lines.push(`## ${k}`, '', '```json', JSON.stringify(v, null, 2), '```', '');
  }

  if (feed.blocks.length > 0) {
    lines.push('## blocks', '');
    for (const b of feed.blocks) {
      lines.push(`- **${b.id}** → variant \`${b.variant}\``);
      if (b.content !== undefined) {
        lines.push('', '  ```json', JSON.stringify(b.content, null, 2), '  ```');
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
