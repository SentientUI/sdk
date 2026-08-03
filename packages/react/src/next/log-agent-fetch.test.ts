import { describe, it, expect, vi } from 'vitest';
import { logAgentFetch } from './log-agent-fetch.js';

describe('logAgentFetch', () => {
  it('POSTs the crawler event with source=ssr and the pk_ key', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    logAgentFetch(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'pk_x', path: '/pricing', botName: 'GPTBot', userAgent: 'GPTBot/1.2' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await Promise.resolve(); // let the fire-and-forget microtask run
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/crawler-events');
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer pk_x');
    expect(JSON.parse(init!.body as string)).toEqual({
      path: '/pricing', botName: 'GPTBot', userAgent: 'GPTBot/1.2', source: 'ssr',
    });
  });

  it('never throws when fetch rejects', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => { throw new Error('network down'); });
    expect(() => logAgentFetch(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'pk_x', path: '/', botName: 'ClaudeBot' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )).not.toThrow();
    await Promise.resolve();
  });
});
