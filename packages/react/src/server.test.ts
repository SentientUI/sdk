import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadAdaptiveAssignments } from './server.js';
import { preloadDecisions } from '@sentientui/core/server';

const BASE_URL = 'https://api.example.com/v1';
const API_KEY = 'pk_test';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadAdaptiveAssignments', () => {
  it('uses session cookie when present', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ variantId: 'primary', assignmentTtlMs: 3600000 }),
      } as Response);

    const cookies = { get: (name: string) => (name === '_snt_uid' ? { value: 'sess-1' } : undefined) };
    const createSessionId = vi.fn(() => 'new-session');

    const result = await loadAdaptiveAssignments(
      [{ id: 'hero_cta', variantIds: ['primary', 'accent'] }],
      { cookies, apiKey: API_KEY, baseUrl: BASE_URL, createSessionId },
    );

    expect(result.assignments).toEqual({ hero_cta: 'primary' });
    expect(result.sessionId).toBe('sess-1');
    expect(createSessionId).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/assign`,
      expect.objectContaining({
        body: JSON.stringify({
          sessionId: 'sess-1',
          componentId: 'hero_cta',
          variantIds: ['primary', 'accent'],
        }),
      }),
    );
  });

  it('creates a session id when cookie is absent', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ variantId: 'accent', assignmentTtlMs: 3600000 }),
      } as Response);

    const cookies = { get: () => undefined };
    const createSessionId = vi.fn(() => 'generated-session');

    const result = await loadAdaptiveAssignments(
      [{ id: 'hero_cta', variantIds: ['primary', 'accent'] }],
      { cookies, apiKey: API_KEY, baseUrl: BASE_URL, createSessionId },
    );

    expect(result.assignments).toEqual({ hero_cta: 'accent' });
    expect(result.sessionId).toBe('generated-session');
    expect(createSessionId).toHaveBeenCalledOnce();
  });
});

describe('loadAdaptiveAssignments — defaultSessionId fallback', () => {
  it('falls back to the Math.random session id format when crypto.randomUUID is unavailable', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ variantId: 'primary', assignmentTtlMs: 3600000 }),
      } as Response);

    // No cookie and no createSessionId -> defaultSessionId() is used.
    // crypto.randomUUID undefined forces the `snt-<ts>-<rand>` branch.
    vi.stubGlobal('crypto', {});

    const cookies = { get: () => undefined };

    const result = await loadAdaptiveAssignments(
      [{ id: 'hero_cta', variantIds: ['primary', 'accent'] }],
      { cookies, apiKey: API_KEY, baseUrl: BASE_URL },
    );

    expect(result.sessionId).toMatch(/^snt-\d+-[0-9a-z]+$/);
    // body carries that same generated session id
    const assignCall = mockFetch.mock.calls.find(([url]) =>
      String(url).endsWith('/assign'),
    );
    expect(assignCall).toBeTruthy();
    const body = JSON.parse((assignCall![1] as RequestInit).body as string);
    expect(body.sessionId).toBe(result.sessionId);
  });

  it('uses crypto.randomUUID when available', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ variantId: 'primary', assignmentTtlMs: 3600000 }),
      } as Response);

    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-from-crypto' });

    const cookies = { get: () => undefined };

    const result = await loadAdaptiveAssignments(
      [{ id: 'hero_cta', variantIds: ['primary', 'accent'] }],
      { cookies, apiKey: API_KEY, baseUrl: BASE_URL },
    );

    expect(result.sessionId).toBe('uuid-from-crypto');
  });
});

describe('preloadDecisions', () => {
  it('calls /v1/decide and returns the parsed result', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({ ok: true } as Response); // sessions
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        layoutOrder: ['pricing', 'hero'],
        assignments: { hero_cta: 'accent' },
        persona: 'buyer',
        confidence: 0.75,
      }),
    } as Response);

    const result = await preloadDecisions(
      {
        sections: ['hero', 'pricing'],
        components: [{ id: 'hero_cta', variantIds: ['default', 'accent'] }],
      },
      'sess-1',
      { apiKey: 'pk_test', baseUrl: 'https://api.example.com/v1' },
    );

    expect(result.layoutOrder).toEqual(['pricing', 'hero']);
    expect(result.assignments).toEqual({ hero_cta: 'accent' });
    expect(result.persona).toBe('buyer');
    expect(result.confidence).toBe(0.75);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/decide',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'sess-1',
          sections: [{ id: 'hero' }, { id: 'pricing' }],
          components: [{ id: 'hero_cta', variantIds: ['default', 'accent'] }],
        }),
      }),
    );
  });

  it('returns fallback (default order, empty assignments) on API error', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({ ok: true } as Response); // sessions
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as Response); // decide fails

    const result = await preloadDecisions(
      { sections: ['hero', 'pricing'], components: [] },
      'sess-2',
      { apiKey: 'pk_test', baseUrl: 'https://api.example.com/v1' },
    );

    expect(result.layoutOrder).toEqual(['hero', 'pricing']);
    expect(result.assignments).toEqual({});
    expect(result.persona).toBe('unknown');
    expect(result.confidence).toBe(0);
  });
});

describe('loadAdaptiveDecision — slots forwarding', () => {
  it('forwards slot declarations and returns slots/persona/confidence', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response); // sessions
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        layoutOrder: [],
        assignments: {},
        slots: { hero: { tone: 'urgent' } },
        persona: 'buyer',
        confidence: 0.8,
      }),
    } as Response);

    const { loadAdaptiveDecision } = await import('./server.js');
    const result = await loadAdaptiveDecision({
      slots: [{ id: 'hero', dims: { tone: ['calm', 'urgent'] } }],
      components: [],
      cookies: { get: () => ({ value: 'sess-slots' }) },
      apiKey: API_KEY,
      baseUrl: BASE_URL,
    });

    expect(result.sessionId).toBe('sess-slots');
    expect(result.slots).toEqual({ hero: { tone: 'urgent' } });
    expect(result.persona).toBe('buyer');
    expect(result.confidence).toBe(0.8);

    const decideCall = mockFetch.mock.calls.find(([u]) => String(u).endsWith('/decide'));
    const body = JSON.parse((decideCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.slots).toEqual([{ id: 'hero', dims: { tone: ['calm', 'urgent'] } }]);
    expect(body.sections).toEqual([]); // sections omitted by the caller → empty
  });
});
