import { describe, it, expect, vi } from 'vitest';
import { sentientAgentMiddleware } from './agent-middleware.js';

function req(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers });
}

describe('sentientAgentMiddleware', () => {
  it('reports a crawler request when the UA matches a known agent token', async () => {
    const onCrawler = vi.fn();
    const mw = sentientAgentMiddleware({ onCrawler });
    const matched = await mw(req('https://x.com/pricing', { 'user-agent': 'Mozilla/5.0 (compatible; ClaudeBot/1.0)' }));
    expect(matched).toBe(true);
    expect(onCrawler).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/pricing', botName: 'ClaudeBot' }),
    );
  });

  it('does nothing for an ordinary human browser UA', async () => {
    const onCrawler = vi.fn();
    const mw = sentientAgentMiddleware({ onCrawler });
    const matched = await mw(req('https://x.com/pricing', { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36' }));
    expect(matched).toBe(false);
    expect(onCrawler).not.toHaveBeenCalled();
  });

  it('never throws when onCrawler fails', async () => {
    const mw = sentientAgentMiddleware({ onCrawler: () => { throw new Error('db down'); } });
    await expect(
      mw(req('https://x.com/p', { 'user-agent': 'GPTBot' })),
    ).resolves.toBe(true);
  });
});
