import { describe, it, expect, vi } from 'vitest';
import { createAgentFeed } from './agent-feed-route.js';
import type { AgentFeed } from '../agent-feed.js';

const FEED: AgentFeed = {
  page: '/pricing',
  title: 'Pricing — Acme',
  summary: 'Three plans',
  blocks: [{ id: 'hero', variant: 'B', content: { headline: 'Save more' } }],
};

function req(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers });
}

describe('createAgentFeed content negotiation', () => {
  it('returns JSON by default', async () => {
    const handler = createAgentFeed({ getFeed: () => FEED });
    const res = await handler(req('https://x.com/pricing'));
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ page: '/pricing', title: 'Pricing — Acme' });
  });

  it('returns Markdown when Accept: text/markdown is sent', async () => {
    const handler = createAgentFeed({ getFeed: () => FEED });
    const res = await handler(req('https://x.com/pricing', { accept: 'text/markdown' }));
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(await res.text()).toContain('# Pricing — Acme');
  });

  it('returns Markdown when the URL ends in .md', async () => {
    const handler = createAgentFeed({ getFeed: () => FEED });
    const res = await handler(req('https://x.com/pricing.md'));
    expect(res.headers.get('content-type')).toContain('text/markdown');
  });

  it('logs each fetch via onRead with the matched bot name', async () => {
    const onRead = vi.fn();
    const handler = createAgentFeed({ getFeed: () => FEED, onRead });
    await handler(req('https://x.com/pricing', { 'user-agent': 'Mozilla/5.0 (compatible; GPTBot/1.2)' }));
    expect(onRead).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/pricing', botName: 'GPTBot' }),
    );
  });

  it('never lets an onRead failure break the response', async () => {
    const onRead = vi.fn(() => {
      throw new Error('db down');
    });
    const handler = createAgentFeed({ getFeed: () => FEED, onRead });
    const res = await handler(req('https://x.com/pricing'));
    expect(res.status).toBe(200);
  });
});
