import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  preloadAssignments,
  preloadDecisions,
  readSessionCookie,
  deriveSessionSegment,
  buildSessionUpsertPayload,
  detectDeviceClass,
  detectTrafficSource,
  detectTimeOfDay,
  referrerDomainFromReferer,
} from './index-server.js';

const BASE_URL = 'https://api.example.com/v1';
const API_KEY = 'pk_test_key';
const SESSION_ID = 'sess-ssr-1';
const CONFIG = { apiKey: API_KEY, baseUrl: BASE_URL };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('@sentientui/core/server entry re-exports', () => {
  it('re-exports the server preload + cookie helpers as callable functions', () => {
    expect(typeof preloadAssignments).toBe('function');
    expect(typeof preloadDecisions).toBe('function');
    expect(typeof readSessionCookie).toBe('function');
  });

  it('re-exports the session-meta helpers', () => {
    expect(detectDeviceClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile')).toBe('mobile');
    expect(detectTrafficSource('https://www.google.com/search?q=x')).toBe('search');
    expect(referrerDomainFromReferer('https://foo.com/bar')).toBe('foo.com');
    expect(['night', 'morning', 'afternoon', 'evening']).toContain(detectTimeOfDay(new Date()));
    expect(deriveSessionSegment({ userAgent: 'Chrome desktop', referer: '' })).toBe('desktop:direct');
    const payload = buildSessionUpsertPayload('s1', { userAgent: 'Chrome' });
    expect(payload.sessionId).toBe('s1');
    expect(payload.deviceClass).toBe('desktop');
  });
});

describe('preloadAssignments via server entry', () => {
  it('returns assigned variants for each component (happy path)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response) // session
      .mockResolvedValueOnce({ ok: true, json: async () => ({ variantId: 'hero-a', assignmentTtlMs: 0 }) } as Response);

    const result = await preloadAssignments(
      [{ id: 'hero', variantIds: ['hero-a', 'hero-b'] }],
      SESSION_ID,
      CONFIG,
    );
    expect(result).toEqual({ hero: 'hero-a' });
  });

  it('omits a component whose assign call throws (network error)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true } as Response) // session upsert
      .mockRejectedValueOnce(new Error('ECONNRESET')); // assign throws

    const result = await preloadAssignments(
      [{ id: 'hero', variantIds: ['hero-a'] }],
      SESSION_ID,
      CONFIG,
    );
    expect(result).toEqual({});
  });

  it('warns and continues when the session upsert returns 402', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 402, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ variantId: 'hero-a', assignmentTtlMs: 0 }) } as Response);

    const result = await preloadAssignments([{ id: 'hero', variantIds: ['hero-a'] }], SESSION_ID, CONFIG);
    expect(result).toEqual({ hero: 'hero-a' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Session limit exceeded'));
  });

  it('sends the Origin header when origin is configured', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ variantId: 'v', assignmentTtlMs: 0 }) } as Response);

    await preloadAssignments(
      [{ id: 'hero', variantIds: ['v'] }],
      SESSION_ID,
      { ...CONFIG, origin: 'https://app.example.com' },
    );

    const headers = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Origin).toBe('https://app.example.com');
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });
});

describe('preloadDecisions via server entry', () => {
  const SECTIONS = ['hero', 'pricing', 'cta'];

  it('returns the decide payload on success', async () => {
    const decide = {
      layoutOrder: ['pricing', 'hero', 'cta'],
      assignments: { hero: 'hero-b' },
      persona: 'bargain_hunter',
      confidence: 0.7,
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response) // session
      .mockResolvedValueOnce({ ok: true, json: async () => decide } as Response); // decide

    const result = await preloadDecisions(
      { sections: SECTIONS, components: [{ id: 'hero', variantIds: ['hero-a', 'hero-b'] }] },
      SESSION_ID,
      CONFIG,
    );
    // 0.10.0: the result always carries a slots map ({} when none declared).
    expect(result).toEqual({ ...decide, slots: {} });
  });

  it('falls back to default section order when /decide responds non-ok', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response) // session
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response); // decide fails

    const result = await preloadDecisions(
      { sections: SECTIONS, components: [] },
      SESSION_ID,
      CONFIG,
    );
    expect(result).toEqual({
      layoutOrder: SECTIONS,
      assignments: {},
      slots: {},
      persona: 'unknown',
      confidence: 0,
    });
  });

  it('falls back when the /decide fetch rejects (timeout/network)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response) // session
      .mockRejectedValueOnce(new DOMException('Aborted', 'AbortError')); // decide rejects

    const result = await preloadDecisions(
      { sections: SECTIONS, components: [] },
      SESSION_ID,
      CONFIG,
    );
    expect(result.layoutOrder).toEqual(SECTIONS);
    expect(result.persona).toBe('unknown');
  });

  it('serializes sections as {id} objects in the decide request body', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ layoutOrder: SECTIONS, assignments: {}, persona: 'p', confidence: 1 }),
      } as Response);

    await preloadDecisions(
      { sections: SECTIONS, components: [{ id: 'hero' }] },
      SESSION_ID,
      CONFIG,
    );

    const decideCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes('/decide'));
    const body = JSON.parse((decideCall![1] as RequestInit).body as string) as {
      sections: Array<{ id: string }>;
      sessionId: string;
    };
    expect(body.sections).toEqual([{ id: 'hero' }, { id: 'pricing' }, { id: 'cta' }]);
    expect(body.sessionId).toBe(SESSION_ID);
  });
});

describe('readSessionCookie via a CookieJar-like object', () => {
  it('returns the value of the _snt_uid cookie', () => {
    const jar = {
      store: new Map<string, string>([['_snt_uid', 'sess-from-jar']]),
      get(name: string) {
        const value = this.store.get(name);
        return value === undefined ? undefined : { value };
      },
    };
    expect(readSessionCookie(jar)).toBe('sess-from-jar');
  });

  it('returns null when the cookie jar lacks _snt_uid', () => {
    const jar = { get: (_name: string) => undefined };
    expect(readSessionCookie(jar)).toBeNull();
  });
});
