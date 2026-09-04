import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { init } from './index.js';

const BASE_CONFIG = {
  apiKey: 'pk_test_abc123',
  ingestUrl: 'https://api.example.com/v1/events',
  context: 'saas' as const,
};

const DECIDE_OK = {
  layoutOrder: ['pricing', 'hero'],
  assignments: { hero_cta: 'accent' },
  slots: { hero: { tone: 'urgent', motion: 'none' }, 'pricing-area': 'social_first' },
  persona: 'buyer',
  confidence: 0.8,
};

function stubFetch(decideResponse: { ok: boolean; status?: number; json?: unknown }) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, opts?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body as string) : null });
    if (url.endsWith('/decide')) {
      return Promise.resolve({
        ok: decideResponse.ok,
        status: decideResponse.status ?? 200,
        json: async () => decideResponse.json ?? {},
      } as Response);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
  }));
  return calls;
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('decide()', () => {
  it('POSTs sections/components/slots and returns the parsed outcome', async () => {
    const calls = stubFetch({ ok: true, json: DECIDE_OK });
    const client = init({ ...BASE_CONFIG });

    const outcome = await client.decide({
      sections: ['hero', 'pricing'],
      components: [{ id: 'hero_cta', variantIds: ['default', 'accent'] }],
      slots: [
        { id: 'hero', dims: { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] } },
        { id: 'pricing-area', arms: ['standard', 'social_first'] },
      ],
    });

    expect(outcome).toEqual({
      layoutOrder: ['pricing', 'hero'],
      assignments: { hero_cta: 'accent' },
      slots: { hero: { tone: 'urgent', motion: 'none' }, 'pricing-area': 'social_first' },
      persona: 'buyer',
      confidence: 0.8,
    });

    const decideCall = calls.find((c) => c.url.endsWith('/decide'));
    expect(decideCall).toBeDefined();
    const body = decideCall!.body as Record<string, unknown>;
    expect(body.sections).toEqual([{ id: 'hero' }, { id: 'pricing' }]);
    expect(body.components).toEqual([{ id: 'hero_cta', variantIds: ['default', 'accent'] }]);
    expect(body.slots).toEqual([
      { id: 'hero', dims: { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] } },
      { id: 'pricing-area', arms: ['standard', 'social_first'] },
    ]);
    expect(typeof body.sessionId).toBe('string');
    client.destroy();
  });

  it('strips SDK-only fields from slot declarations before the wire', async () => {
    const calls = stubFetch({ ok: true, json: { ...DECIDE_OK, slots: {} } });
    const client = init({ ...BASE_CONFIG });

    await client.decide({
      slots: [
        { id: 'hero', dims: { tone: ['calm', 'urgent'] }, goal: 'buy_click', extra: 1 } as never,
      ],
    });

    const body = calls.find((c) => c.url.endsWith('/decide'))!.body as { slots: unknown[] };
    expect(body.slots).toEqual([{ id: 'hero', dims: { tone: ['calm', 'urgent'] } }]);
    client.destroy();
  });

  it('omits the slots key when no slots are declared', async () => {
    const calls = stubFetch({ ok: true, json: DECIDE_OK });
    const client = init({ ...BASE_CONFIG });

    await client.decide({ sections: ['hero'] });

    const body = calls.find((c) => c.url.endsWith('/decide'))!.body as Record<string, unknown>;
    expect('slots' in body).toBe(false);
    client.destroy();
  });

  it('serves baseline everywhere without retry when response.slots is undefined (server predates slots)', async () => {
    const calls = stubFetch({
      ok: true,
      json: { layoutOrder: ['hero'], assignments: {}, persona: 'unknown', confidence: 0 },
    });
    const client = init({ ...BASE_CONFIG });

    const outcome = await client.decide({
      slots: [
        { id: 'hero', dims: { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] } },
        { id: 'pricing-area', arms: ['standard', 'social_first'], baseline: 'standard' },
      ],
    });

    expect(outcome!.slots).toEqual({
      hero: { tone: 'calm', motion: 'none' },
      'pricing-area': 'standard',
    });
    // No retry: exactly one /decide call.
    expect(calls.filter((c) => c.url.endsWith('/decide'))).toHaveLength(1);
    client.destroy();
  });

  // The failure path (seedSlotBaselines) always guarded with has(); the
  // success path wrote synthesized baselines unconditionally, clobbering
  // SSR-seeded / previously-served results for slots the response omitted.
  it('does not overwrite an SSR-seeded slot with a synthesized baseline when the response omits it', async () => {
    stubFetch({ ok: true, json: { assignments: {}, persona: 'buyer', confidence: 0.8 } });
    const client = init({
      ...BASE_CONFIG,
      initialSlots: { hero: { tone: 'urgent', motion: 'pulse' } },
    });

    const outcome = await client.decide({
      slots: [{ id: 'hero', dims: { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] } }],
    });

    // Served result stands — both in the store and in the returned outcome
    // (the declared baseline would have been { tone: 'calm', motion: 'none' }).
    expect(client.getSlotResult('hero')).toEqual({ tone: 'urgent', motion: 'pulse' });
    expect(outcome!.slots.hero).toEqual({ tone: 'urgent', motion: 'pulse' });
    client.destroy();
  });

  it('a served slot in the response still overwrites a previous result', async () => {
    stubFetch({ ok: true, json: { slots: { hero: { tone: 'calm', motion: 'none' } }, persona: 'buyer', confidence: 0.8 } });
    const client = init({
      ...BASE_CONFIG,
      initialSlots: { hero: { tone: 'urgent', motion: 'pulse' } },
    });

    await client.decide({
      slots: [{ id: 'hero', dims: { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] } }],
    });
    expect(client.getSlotResult('hero')).toEqual({ tone: 'calm', motion: 'none' });
    client.destroy();
  });

  it('returns null on a non-ok response', async () => {
    stubFetch({ ok: false, status: 500 });
    const client = init({ ...BASE_CONFIG });
    expect(await client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] })).toBeNull();
    client.destroy();
  });

  it('awaits the session upsert before calling /v1/decide', async () => {
    let releaseSession: () => void = () => undefined;
    const gate = new Promise<void>((r) => { releaseSession = r; });
    const order: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/sessions')) {
        order.push('sessions');
        return gate.then(() => ({ ok: true, json: async () => ({}) } as Response));
      }
      order.push('decide');
      return Promise.resolve({ ok: true, json: async () => DECIDE_OK } as Response);
    }));

    const client = init({ ...BASE_CONFIG });
    const pending = client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['sessions']); // decide is parked behind sessionReady
    releaseSession();
    await pending;
    expect(order).toEqual(['sessions', 'decide']);
    client.destroy();
  });

  it('sends the declared persona on both the session upsert and the decide body', async () => {
    const calls = stubFetch({ ok: true, json: DECIDE_OK });
    const client = init({ ...BASE_CONFIG, persona: 'admin' });
    await client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });

    const sessionCall = calls.find((c) => c.url.endsWith('/sessions'));
    expect((sessionCall!.body as Record<string, unknown>).persona).toBe('admin');
    const decideCall = calls.find((c) => c.url.endsWith('/decide'));
    expect((decideCall!.body as Record<string, unknown>).persona).toBe('admin');
    client.destroy();
  });

  it('omits persona from the wire entirely when not configured', async () => {
    const calls = stubFetch({ ok: true, json: DECIDE_OK });
    const client = init({ ...BASE_CONFIG });
    await client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });

    for (const c of calls) {
      expect(c.body === null || !('persona' in (c.body as Record<string, unknown>))).toBe(true);
    }
    client.destroy();
  });

  it('seeds returned assignments into the local cache (assign() cache-hits afterwards)', async () => {
    stubFetch({ ok: true, json: DECIDE_OK });
    const client = init({ ...BASE_CONFIG });
    await client.decide({ components: [{ id: 'hero_cta', variantIds: ['default', 'accent'] }] });
    const result = await client.assign('hero_cta', ['default', 'accent']);
    expect(result?.variantId).toBe('accent');
    // 1 sessions + 1 decide; assign() must NOT have hit the network.
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/assign'))).toHaveLength(0);
    client.destroy();
  });

  it('does not downgrade a known initialPersona when the response omits persona', async () => {
    // Response carries no persona field (older server / holdout path).
    stubFetch({ ok: true, json: { layoutOrder: null, assignments: {}, slots: {} } });
    const client = init({ ...BASE_CONFIG, initialPersona: { persona: 'buyer', confidence: 0.8 } });

    const outcome = await client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });

    expect(outcome?.persona).toBe('buyer');
    expect(client.getPersona()?.persona).toBe('buyer');
    // The regression must not be persisted for the next visit's pre-paint.
    const snap = JSON.parse(localStorage.getItem('_snt_snap:' + BASE_CONFIG.apiKey)!) as { persona: string };
    expect(snap.persona).toBe('buyer');
    client.destroy();
  });

  it('does not downgrade a known persona even when the response explicitly says "unknown"', async () => {
    stubFetch({ ok: true, json: { layoutOrder: null, assignments: {}, slots: {}, persona: 'unknown', confidence: 0 } });
    const client = init({ ...BASE_CONFIG, initialPersona: { persona: 'buyer', confidence: 0.8 } });

    const outcome = await client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });

    expect(outcome?.persona).toBe('buyer');
    client.destroy();
  });

  it('adopts a new known persona returned by the response', async () => {
    stubFetch({ ok: true, json: { layoutOrder: null, assignments: {}, slots: {}, persona: 'researcher', confidence: 0.6 } });
    const client = init({ ...BASE_CONFIG, initialPersona: { persona: 'buyer', confidence: 0.8 } });

    const outcome = await client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });

    expect(outcome?.persona).toBe('researcher');
    expect(client.getPersona()?.persona).toBe('researcher');
    client.destroy();
  });

  it('forwards a registry-mode sectionMap through the outcome', async () => {
    const sectionMap = [
      { urlMatch: '/', locator: { v: 1, selector: 'section.plans' }, type: 'pricing' },
    ];
    stubFetch({ ok: true, json: { ...DECIDE_OK, sectionMap } });
    const client = init({ ...BASE_CONFIG });

    const outcome = await client.decide({ slotsFrom: 'registry', components: [] });

    expect(outcome?.sectionMap).toEqual(sectionMap);
    client.destroy();
  });

  it('writes the decision snapshot after every successful decide', async () => {
    stubFetch({ ok: true, json: DECIDE_OK });
    const client = init({ ...BASE_CONFIG });
    await client.decide({
      sections: ['hero', 'pricing'],
      slots: [{ id: 'hero', dims: { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] } }],
    });

    const raw = localStorage.getItem('_snt_snap:' + BASE_CONFIG.apiKey);
    expect(raw).toBeTruthy();
    const snap = JSON.parse(raw!) as Record<string, unknown>;
    expect(snap).toMatchObject({
      v: 1,
      persona: 'buyer',
      band: 'high',
      layoutOrder: ['pricing', 'hero'],
    });
    expect((snap.slots as Record<string, unknown>).hero).toEqual({ tone: 'urgent', motion: 'none' });
    expect(typeof snap.savedAt).toBe('number');
    client.destroy();
  });

  // CORE-16: per-slot lazy-decide patterns fire one decide per mounted slot in
  // the same tick; without coalescing that was N roundtrips + N snapshot
  // rewrites for a single page.
  it('coalesces concurrent identical decides into one request and one snapshot write', async () => {
    const calls = stubFetch({ ok: true, json: DECIDE_OK });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const client = init({ ...BASE_CONFIG });

    // Two separately-constructed but identical inputs: coalescing must key on
    // request CONTENT, not object identity.
    const input = () => ({
      slots: [{ id: 'hero', dims: { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] } }],
    });
    const [a, b] = await Promise.all([client.decide(input()), client.decide(input())]);

    expect(calls.filter((c) => c.url.endsWith('/decide'))).toHaveLength(1);
    expect(a).toEqual(b);
    expect(a?.slots.hero).toEqual({ tone: 'urgent', motion: 'none' });
    expect(
      setItem.mock.calls.filter(([k]) => k === '_snt_snap:' + BASE_CONFIG.apiKey),
    ).toHaveLength(1);
    client.destroy();
  });

  it('does NOT coalesce concurrent decides whose slot sets differ', async () => {
    const calls = stubFetch({ ok: true, json: DECIDE_OK });
    const client = init({ ...BASE_CONFIG });

    // Sharing one promise here would hand the second caller an outcome that
    // never decided (or baselined) its slot.
    const [a, b] = await Promise.all([
      client.decide({ slots: [{ id: 'hero', dims: { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] } }] }),
      client.decide({ slots: [{ id: 'pricing-area', arms: ['standard', 'social_first'] }] }),
    ]);

    expect(calls.filter((c) => c.url.endsWith('/decide'))).toHaveLength(2);
    expect(a?.slots).toHaveProperty('hero');
    expect(b?.slots).toHaveProperty('pricing-area');
    client.destroy();
  });

  it('a settled decide leaves the in-flight map: the same input fetches again later', async () => {
    const calls = stubFetch({ ok: true, json: DECIDE_OK });
    const client = init({ ...BASE_CONFIG });
    const input = { slots: [{ id: 'hero', arms: ['a', 'b'] }] };

    await client.decide(input);
    await client.decide(input);

    // Coalescing dedupes CONCURRENT calls only — a sequential re-decide is a
    // fresh decision, not a stale cache hit.
    expect(calls.filter((c) => c.url.endsWith('/decide'))).toHaveLength(2);
    client.destroy();
  });

  it('a failed decide is not stuck in the in-flight map (retry issues a new request)', async () => {
    const calls = stubFetch({ ok: false, status: 500 });
    const client = init({ ...BASE_CONFIG });
    const input = { slots: [{ id: 'hero', arms: ['a', 'b'] }] };

    expect(await client.decide(input)).toBeNull();
    expect(await client.decide(input)).toBeNull();

    expect(calls.filter((c) => c.url.endsWith('/decide'))).toHaveLength(2);
    client.destroy();
  });
});
