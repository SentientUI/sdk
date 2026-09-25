import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init } from './index.js';
import { DECIDE_TIMEOUT_MS, REQUEST_TIMEOUT_MS, SESSION_WAIT_MS } from './timeout.js';

// Audit S8: browser fetches had no timeout, and decide/assign waited on the
// whole session retry chain (~14 s under 429s).

const CONFIG = { apiKey: 'pk_test_timeouts', ingestUrl: 'https://api.example.com/v1/events' };
const never = () => new Promise<Response>(() => undefined);

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bounded session wait', () => {
  it('a decide whose session never registers is not sent: baselines, no trial', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string) => (urls.push(String(u)), never())));
    const client = init(CONFIG);
    const p = client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });
    await vi.advanceTimersByTimeAsync(SESSION_WAIT_MS + 1);
    await expect(p).resolves.toBeNull();
    expect(urls.some((u) => u.endsWith('/decide'))).toBe(false);
    expect(client.getSlotResult('hero')).toBe('a');
    expect(client.isSlotDecided?.('hero')).toBe(false);
    client.dispose();
  });

  it('an assign likewise gives up without sending', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string) => (urls.push(String(u)), never())));
    const client = init(CONFIG);
    const p = client.assign('hero', ['a', 'b']);
    await vi.advanceTimersByTimeAsync(SESSION_WAIT_MS + 1);
    await expect(p).resolves.toBeNull();
    expect(urls.some((u) => u.endsWith('/assign'))).toBe(false);
    client.dispose();
  });
});

describe('request ceilings', () => {
  it('a SENT decide is not cut short on latency — the server has already booked its trial', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    let answer!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((u: string, init?: RequestInit) => {
        if (!String(u).endsWith('/decide')) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
        signals.push(init?.signal ?? undefined);
        return new Promise<Response>((res, reject) => {
          answer = res;
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }),
    );
    const client = init(CONFIG);
    const p = client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(signals[0]?.aborted).toBe(false);
    // A 10 s answer is still applied (late), not thrown away.
    answer({ ok: true, status: 200, json: async () => ({ slots: { hero: 'b' } }) } as Response);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toMatchObject({ slots: { hero: 'b' } });
    client.dispose();
  });

  it('only a dead connection is released, at DECIDE_TIMEOUT_MS', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((u: string, init?: RequestInit) => {
        if (String(u).endsWith('/sessions')) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
        signals.push(init?.signal ?? undefined);
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }),
    );
    const client = init(CONFIG);
    const p = client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });
    await vi.advanceTimersByTimeAsync(DECIDE_TIMEOUT_MS + 1);
    expect(signals[0]?.aborted).toBe(true);
    await expect(p).resolves.toBeNull();
    client.dispose();
  });

  it('a stalled weights poll resolves empty instead of hanging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((u: string, init?: RequestInit) =>
        String(u).endsWith('/weights')
          ? new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
          : Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response),
      ),
    );
    const client = init(CONFIG);
    const p = client.fetchWeights();
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    await expect(p).resolves.toEqual([]);
    client.dispose();
  });
});
