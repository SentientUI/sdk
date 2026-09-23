import { describe, it, expect, vi } from 'vitest';
import { captureAgentRequest, sentientAgentMiddleware } from './agent-capture.js';

const UA_GPT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot';
const UA_HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15';

function req(url: string, ua: string | null) {
  return { url, headers: { get: (n: string) => (n.toLowerCase() === 'user-agent' ? ua : null) } };
}

describe('captureAgentRequest', () => {
  it('a known assistant is posted — path only, no query string — and waitUntil gets the promise', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const waitUntil = vi.fn();
    const hit = captureAgentRequest(req('https://shop.example/pricing?email=a%40b.c#x', UA_GPT), {
      apiKey: 'pk_test', baseUrl: 'https://api.test/v1', source: 'edge', fetchImpl, waitUntil,
    });
    expect(hit).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/crawler-events');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ path: '/pricing', source: 'edge', userAgent: UA_GPT });
    expect(body.botName).toBeTruthy();
    expect(init.body as string).not.toContain('email');
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('a person makes NO network call', () => {
    const fetchImpl = vi.fn();
    expect(captureAgentRequest(req('https://x/p', UA_HUMAN), { apiKey: 'pk', fetchImpl })).toBe(false);
    expect(captureAgentRequest(req('https://x/p', null), { apiKey: 'pk', fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws into the page: a failing fetch, a throwing fetch, broken headers', async () => {
    const rejecting = vi.fn(async () => { throw new Error('network down'); });
    expect(() => captureAgentRequest(req('https://x/p', UA_GPT), { apiKey: 'pk', fetchImpl: rejecting })).not.toThrow();
    const throwing = vi.fn(() => { throw new Error('sync boom'); }) as unknown as typeof fetch;
    expect(() => captureAgentRequest(req('https://x/p', UA_GPT), { apiKey: 'pk', fetchImpl: throwing })).not.toThrow();
    const broken = { url: 'https://x/p', headers: { get: () => { throw new Error('bad'); } } };
    expect(captureAgentRequest(broken, { apiKey: 'pk', fetchImpl: rejecting })).toBe(false);
  });
});

describe('sentientAgentMiddleware', () => {
  it('calls next() synchronously, logs agents with originalUrl, never touches the response', () => {
    const fetchImpl = vi.fn(async () => new Response(null));
    const mw = sentientAgentMiddleware({ apiKey: 'pk', fetchImpl });
    const next = vi.fn();
    const res = {};
    mw({ url: '/p', originalUrl: '/shop/p?utm=1', headers: { 'user-agent': UA_GPT } }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchImpl.mock.calls[0]! as unknown as [string, RequestInit])[1].body as string))
      .toMatchObject({ path: '/shop/p', source: 'middleware' });
    expect(res).toEqual({});
    mw({ url: '/p', headers: { 'user-agent': UA_HUMAN } }, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
