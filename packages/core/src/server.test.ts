import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { preloadAssignments, readSessionCookie } from './server.js';

const BASE_URL = 'https://api.example.com/v1';
const API_KEY = 'pk_test_key';
const SESSION_ID = 'sess-ssr-1';
const CONFIG = { apiKey: API_KEY, baseUrl: BASE_URL };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(responses: Array<{ ok: boolean; json?: unknown }>) {
  const mockFn = vi.mocked(fetch);
  for (const r of responses) {
    mockFn.mockResolvedValueOnce({
      ok: r.ok,
      json: async () => r.json ?? {},
    } as Response);
  }
}

describe('preloadAssignments', () => {
  it('returns an empty map for an empty components list', async () => {
    // session upsert
    mockFetch([{ ok: true }]);

    const result = await preloadAssignments([], SESSION_ID, CONFIG);

    expect(result).toEqual({});
  });

  // audit P4: an opted-out visitor (DNT/GPC observed server-side) must not have
  // a session minted or an assignment fetched during SSR.
  it('short-circuits with no fetch when doNotTrack is set', async () => {
    const result = await preloadAssignments(
      [{ id: 'hero', variantIds: ['hero-a', 'hero-b'] }],
      SESSION_ID,
      { ...CONFIG, doNotTrack: true },
    );
    expect(result).toEqual({});
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('returns assigned variants for each component', async () => {
    mockFetch([
      { ok: true }, // session upsert
      { ok: true, json: { variantId: 'hero-a', assignmentTtlMs: 3600000 } },
      { ok: true, json: { variantId: 'cta-short', assignmentTtlMs: 3600000 } },
    ]);

    const result = await preloadAssignments(
      [
        { id: 'hero', variantIds: ['hero-a', 'hero-b'] },
        { id: 'cta', variantIds: ['cta-short', 'cta-long'] },
      ],
      SESSION_ID,
      CONFIG,
    );

    expect(result).toEqual({ hero: 'hero-a', cta: 'cta-short' });
  });

  it('sends session metadata on upsert (not bare sessionId)', async () => {
    const mockFn = vi.mocked(fetch);
    mockFn.mockResolvedValueOnce({ ok: true } as Response);
    mockFn.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ variantId: 'hero-a', assignmentTtlMs: 0 }),
    } as Response);

    await preloadAssignments(
      [{ id: 'hero', variantIds: ['hero-a'] }],
      SESSION_ID,
      {
        ...CONFIG,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
        referer: 'http://localhost:3001/',
        origin: 'http://localhost:3001',
      },
    );

    const sessionCall = mockFn.mock.calls[0];
    const body = JSON.parse(sessionCall[1]?.body as string) as {
      deviceClass: string;
      trafficSource: string;
    };
    expect(body.deviceClass).toBe('desktop');
    expect(body.trafficSource).toBe('direct');
  });

  it('omits components whose assign call fails', async () => {
    mockFetch([
      { ok: true }, // session upsert
      { ok: true, json: { variantId: 'hero-a', assignmentTtlMs: 0 } },
      { ok: false }, // cta fails
    ]);

    const result = await preloadAssignments(
      [
        { id: 'hero', variantIds: ['hero-a', 'hero-b'] },
        { id: 'cta', variantIds: ['cta-short', 'cta-long'] },
      ],
      SESSION_ID,
      CONFIG,
    );

    expect(result).toEqual({ hero: 'hero-a' });
    expect(result.cta).toBeUndefined();
  });

  it('fires all assign calls concurrently', async () => {
    const order: string[] = [];

    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = input.toString();
      order.push(url.includes('/sessions') ? 'session' : 'assign');
      return { ok: true, json: async () => ({ variantId: 'v-a', assignmentTtlMs: 0 }) } as Response;
    });

    await preloadAssignments(
      [
        { id: 'c1', variantIds: ['v-a'] },
        { id: 'c2', variantIds: ['v-a'] },
        { id: 'c3', variantIds: ['v-a'] },
      ],
      SESSION_ID,
      CONFIG,
    );

    // Session upsert fires first, then all three assign calls run (order among
    // them is not guaranteed but all three must be present).
    expect(order[0]).toBe('session');
    expect(order.filter((o) => o === 'assign')).toHaveLength(3);
  });

  it('continues when the session upsert throws', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ variantId: 'hero-a', assignmentTtlMs: 0 }),
      } as Response);

    const result = await preloadAssignments(
      [{ id: 'hero', variantIds: ['hero-a'] }],
      SESSION_ID,
      CONFIG,
    );

    expect(result).toEqual({ hero: 'hero-a' });
  });
});

describe('fetchWithTimeout behavior (via preloadAssignments)', () => {
  it('passes an AbortController signal on every fetch call', async () => {
    const seenSignals: Array<AbortSignal | undefined> = [];
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      seenSignals.push((init as RequestInit | undefined)?.signal ?? undefined);
      return { ok: true, json: async () => ({ variantId: 'v-a', assignmentTtlMs: 0 }) } as Response;
    });

    await preloadAssignments(
      [{ id: 'hero', variantIds: ['v-a'] }],
      SESSION_ID,
      CONFIG,
    );

    // session upsert + 1 assign = 2 calls, each with a real AbortSignal.
    expect(seenSignals).toHaveLength(2);
    for (const sig of seenSignals) {
      expect(sig).toBeInstanceOf(AbortSignal);
      expect(sig!.aborted).toBe(false);
    }
  });

  it('clears the abort timer on success (no dangling timeout leaves the signal un-aborted)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      capturedSignal = (init as RequestInit | undefined)?.signal ?? undefined;
      return { ok: true, json: async () => ({ variantId: 'v-a', assignmentTtlMs: 0 }) } as Response;
    });

    await preloadAssignments([{ id: 'hero', variantIds: ['v-a'] }], SESSION_ID, CONFIG);

    // .finally(clearTimeout) ran for each fetch.
    expect(clearSpy).toHaveBeenCalled();
    // Signal was never aborted because the request resolved before the timeout.
    expect(capturedSignal?.aborted).toBe(false);
    clearSpy.mockRestore();
  });

  it('aborts the request when the timeout elapses before fetch resolves', async () => {
    let assignAborted = false;
    vi.mocked(fetch).mockImplementation((input, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal!;
        signal.addEventListener('abort', () => {
          if (input.toString().includes('/assign')) assignAborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
    );

    // Real (short) timeout so the AbortController fires for real.
    const result = await preloadAssignments(
      [{ id: 'hero', variantIds: ['v-a'] }],
      SESSION_ID,
      { ...CONFIG, timeoutMs: 20 },
    );

    expect(assignAborted).toBe(true);
    // Aborted assign is rejected → component omitted from the map.
    expect(result).toEqual({});
  });

  it('builds request URLs by concatenating baseUrl verbatim (no trailing-slash normalisation)', async () => {
    const urls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input) => {
      urls.push(input.toString());
      return { ok: true, json: async () => ({ variantId: 'v-a', assignmentTtlMs: 0 }) } as Response;
    });

    // baseUrl WITH a trailing slash → produces a double slash before the path,
    // documenting that callers must pass baseUrl without a trailing slash.
    await preloadAssignments(
      [{ id: 'hero', variantIds: ['v-a'] }],
      SESSION_ID,
      { apiKey: API_KEY, baseUrl: 'https://api.example.com/v1/' },
    );

    expect(urls).toContain('https://api.example.com/v1//sessions');
    expect(urls).toContain('https://api.example.com/v1//assign');
  });

  it('builds clean URLs when baseUrl has no trailing slash', async () => {
    const urls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input) => {
      urls.push(input.toString());
      return { ok: true, json: async () => ({ variantId: 'v-a', assignmentTtlMs: 0 }) } as Response;
    });

    await preloadAssignments([{ id: 'hero', variantIds: ['v-a'] }], SESSION_ID, CONFIG);
    expect(urls).toContain('https://api.example.com/v1/sessions');
    expect(urls).toContain('https://api.example.com/v1/assign');
  });
});

describe('readSessionCookie', () => {
  it('returns the session ID when the cookie is present', () => {
    const cookies = { get: (name: string) => name === '_snt_uid' ? { value: 'sess-xyz' } : undefined };
    expect(readSessionCookie(cookies)).toBe('sess-xyz');
  });

  it('returns null when the cookie is absent', () => {
    const cookies = { get: () => undefined };
    expect(readSessionCookie(cookies)).toBeNull();
  });
});

describe('preloadDecisions — slots', () => {
  async function callWithSlots(decideJson: unknown, ok = true) {
    const { preloadDecisions } = await import('./server.js');
    const mockFn = vi.mocked(fetch);
    mockFn.mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response); // sessions
    mockFn.mockResolvedValueOnce({ ok, status: ok ? 200 : 500, json: async () => decideJson } as Response); // decide
    return preloadDecisions(
      {
        sections: ['hero', 'pricing'],
        components: [],
        slots: [
          { id: 'hero', dims: { tone: ['calm', 'urgent'] } },
          { id: 'pricing-area', arms: ['standard', 'social_first'] },
        ],
      },
      SESSION_ID,
      CONFIG,
    );
  }

  it('sends slot declarations on the wire and returns served slots + persona/confidence', async () => {
    const result = await callWithSlots({
      layoutOrder: ['pricing', 'hero'],
      assignments: {},
      slots: { hero: { tone: 'urgent' }, 'pricing-area': 'social_first' },
      persona: 'buyer',
      confidence: 0.9,
    });

    expect(result.slots).toEqual({ hero: { tone: 'urgent' }, 'pricing-area': 'social_first' });
    expect(result.persona).toBe('buyer');
    expect(result.confidence).toBe(0.9);

    const decideCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith('/decide'));
    const body = JSON.parse((decideCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.slots).toEqual([
      { id: 'hero', dims: { tone: ['calm', 'urgent'] } },
      { id: 'pricing-area', arms: ['standard', 'social_first'] },
    ]);
  });

  it('resolves every declared slot to baseline when response.slots is undefined (old API)', async () => {
    const result = await callWithSlots({ layoutOrder: ['hero', 'pricing'], assignments: {} });
    expect(result.slots).toEqual({ hero: { tone: 'calm' }, 'pricing-area': 'standard' });
  });

  it('returns baseline slots in the fallback when decide fails', async () => {
    const result = await callWithSlots({}, false);
    expect(result.layoutOrder).toEqual(['hero', 'pricing']);
    expect(result.slots).toEqual({ hero: { tone: 'calm' }, 'pricing-area': 'standard' });
    expect(result.persona).toBe('unknown');
    expect(result.confidence).toBe(0);
  });

  it('omits the slots wire field and works without sections (slots-only page)', async () => {
    const { preloadDecisions } = await import('./server.js');
    const mockFn = vi.mocked(fetch);
    mockFn.mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response);
    mockFn.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ layoutOrder: [], assignments: { c1: 'a' }, persona: 'unknown', confidence: 0 }),
    } as Response);

    const result = await preloadDecisions(
      { components: [{ id: 'c1', variantIds: ['a', 'b'] }] },
      SESSION_ID,
      CONFIG,
    );

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith('/decide'))![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect('slots' in body).toBe(false);
    expect(body.sections).toEqual([]);
    expect(result.slots).toEqual({});
    expect(result.assignments).toEqual({ c1: 'a' });
  });
});
