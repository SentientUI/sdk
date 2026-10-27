import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { preloadAssignments, readSessionCookie, trackServerGoal, signUserId, sha256Fallback, SERVER_GOAL_NAMESPACE, uuidV5, sha1Fallback } from './server.js';
import { createHash } from 'node:crypto';

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
  it('returns the session ID when the legacy bare cookie is present', () => {
    const cookies = { get: (name: string) => name === '_snt_uid' ? { value: 'sess-xyz' } : undefined };
    expect(readSessionCookie(cookies)).toBe('sess-xyz');
  });

  it('returns null when the cookie is absent', () => {
    const cookies = { get: () => undefined };
    expect(readSessionCookie(cookies, API_KEY)).toBeNull();
  });

  // The reader pinned against the WRITER, not against a string literal: the
  // client's initSession writes the per-project suffixed cookie, and this
  // reader once kept the pre-namespacing bare name — so every SSR request for
  // a returning visitor missed the cookie and minted a fresh orphan session.
  // Running the real writer here means the two can never drift apart again.
  it('reads the exact cookie name the client session writer produces', async () => {
    const { initSession } = await import('./session.js');
    const apiKey = 'pk_ssr_pin_key_1234';
    const manager = initSession({ apiKey });
    const id = manager.getSessionId();
    expect(id).toBeTruthy();
    // Adapt the jsdom cookie jar to the Next.js cookies() shape.
    const jar = new Map(
      document.cookie
        .split('; ')
        .filter((c) => c.includes('='))
        .map((c) => {
          const i = c.indexOf('=');
          return [c.slice(0, i), { value: decodeURIComponent(c.slice(i + 1)) }] as const;
        }),
    );
    expect(readSessionCookie({ get: (n) => jar.get(n) }, apiKey)).toBe(id);
    // Without the apiKey the suffixed cookie is invisible — the reason the
    // helper takes the key at all.
    expect(readSessionCookie({ get: (n) => jar.get(n) })).toBeNull();
    manager.destroy();
  });

  it('prefers the suffixed cookie over a lingering legacy one', async () => {
    const { sessionCookieName } = await import('./storage-key.js');
    const jar: Record<string, string> = {
      [sessionCookieName('pk_two_names')]: 'namespaced-id',
      _snt_uid: 'legacy-id',
    };
    const cookies = { get: (n: string) => (jar[n] !== undefined ? { value: jar[n]! } : undefined) };
    expect(readSessionCookie(cookies, 'pk_two_names')).toBe('namespaced-id');
    // A keyed read still falls back to the legacy name when the suffixed
    // cookie is missing (pre-namespacing visitors keep their identity).
    delete jar[sessionCookieName('pk_two_names')];
    expect(readSessionCookie(cookies, 'pk_two_names')).toBe('legacy-id');
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
      persona: 'admin',
      confidence: 0.9,
    });

    expect(result.slots).toEqual({ hero: { tone: 'urgent' }, 'pricing-area': 'social_first' });
    expect(result.persona).toBe('admin');
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

describe('preloadDecisions — registry mode (slotConfig/palette)', () => {
  const CFG_ENTRY = { kind: 'arms', content: 'Generated headline' };
  const PALETTE = { primaryBg: '#111827', primaryText: '#ffffff', radius: '4px' };

  // `null` = omit registrySlotIds (an explicit `undefined` would take the default).
  async function callRegistry(decideJson: unknown, registrySlotIds: string[] | null = ['hero']) {
    const { preloadDecisions } = await import('./server.js');
    const mockFn = vi.mocked(fetch);
    mockFn.mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response); // sessions
    mockFn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => decideJson } as Response); // decide
    return preloadDecisions(
      { components: [], slotsFrom: 'registry', ...(registrySlotIds ? { registrySlotIds } : {}) },
      SESSION_ID,
      CONFIG,
    );
  }

  it('scopes the registry decide to the page\'s ids (bootstrap:false) — never unscoped', async () => {
    // Close-out turns every slot decision into a trial without checking an
    // exposure; an unscoped registry decide minted one for every published
    // slot on every page (CONTRACTS §2).
    await callRegistry({ layoutOrder: [], assignments: {}, slots: {}, persona: 'unknown', confidence: 0 }, ['hero', 'faq']);
    const decideCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith('/decide'));
    const body = JSON.parse((decideCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ slotsFrom: 'registry', registrySlotIds: ['hero', 'faq'], bootstrap: false });
  });

  it('refuses registry mode without ids: downgrades to request mode with one console.error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await callRegistry({ layoutOrder: [], assignments: {}, slots: {}, persona: 'unknown', confidence: 0 }, null);
    const decideCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith('/decide'));
    const body = JSON.parse((decideCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.slotsFrom).toBeUndefined();
    expect(body.registrySlotIds).toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]![0])).toContain('registrySlotIds');
    errSpy.mockRestore();
  });

  it('declares render capabilities per slot with no fingerprint (SSR has no DOM)', async () => {
    // Without a `render` field the server treats the caller as a legacy SDK
    // and never draws a Rewrite arm; SSR can't fingerprint, so it assumes a
    // match and the browser reports real drift.
    await callRegistry({ layoutOrder: [], assignments: {}, slots: {}, persona: 'unknown', confidence: 0 }, ['hero']);
    const decideCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith('/decide'));
    const body = JSON.parse((decideCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.render).toEqual({ hero: { forms: true, compose: true, ops: false } });
  });

  it('an empty id list is a valid scope ("nothing published is on this page")', async () => {
    await callRegistry({ layoutOrder: [], assignments: {}, slots: {}, persona: 'unknown', confidence: 0 }, []);
    const decideCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith('/decide'));
    const body = JSON.parse((decideCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ slotsFrom: 'registry', registrySlotIds: [] });
  });

  it('sends slotsFrom on the wire and returns slotConfig, palette, and undeclared served slots', async () => {
    const result = await callRegistry({
      layoutOrder: [],
      assignments: {},
      slots: { hero: 'evaluator_v1' },
      slotConfig: { hero: CFG_ENTRY },
      palette: PALETTE,
      persona: 'evaluator',
      confidence: 0.8,
    });

    // Registry slots arrive undeclared — they must still land in the result.
    expect(result.slots).toEqual({ hero: 'evaluator_v1' });
    expect(result.slotConfig).toEqual({ hero: CFG_ENTRY });
    expect(result.palette).toEqual(PALETTE);

    const decideCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith('/decide'));
    const body = JSON.parse((decideCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.slotsFrom).toBe('registry');
  });

  it('omits slotConfig/palette when the response has none', async () => {
    const result = await callRegistry({ layoutOrder: [], assignments: {}, persona: 'unknown', confidence: 0 });
    expect(result.slotConfig).toBeUndefined();
    expect(result.palette).toBeUndefined();
  });
});

// B23: SSR calls from one server address all shared the API's 100/min per-IP
// cap; a project's own sk_ in X-Sentient-Server-Key lifts it to the plan limit.
describe('serverKey (X-Sentient-Server-Key)', () => {
  it('sends the server key on every SSR call when configured, server-side only', async () => {
    vi.stubGlobal('window', undefined);
    mockFetch([{ ok: true }, { ok: true, json: { variantId: 'hero-a', assignmentTtlMs: 1000 } }]);
    await preloadAssignments([{ id: 'hero', variantIds: ['hero-a'] }], SESSION_ID, { ...CONFIG, serverKey: 'sk_live_x' });
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, init] of calls) {
      expect((init?.headers as Record<string, string>)['X-Sentient-Server-Key']).toBe('sk_live_x');
    }
  });

  it('never sends it when a window exists (bundled into the browser by mistake), nor when unset', async () => {
    vi.stubGlobal('window', {});
    mockFetch([{ ok: true }, { ok: true, json: { variantId: 'hero-a', assignmentTtlMs: 1000 } }]);
    await preloadAssignments([{ id: 'hero', variantIds: ['hero-a'] }], SESSION_ID, { ...CONFIG, serverKey: 'sk_live_x' });
    vi.stubGlobal('window', undefined);
    mockFetch([{ ok: true }, { ok: true, json: { variantId: 'hero-a', assignmentTtlMs: 1000 } }]);
    await preloadAssignments([{ id: 'hero', variantIds: ['hero-a'] }], SESSION_ID, CONFIG);
    for (const [, init] of vi.mocked(fetch).mock.calls) {
      expect((init?.headers as Record<string, string>)['X-Sentient-Server-Key']).toBeUndefined();
    }
  });
});

describe('trackServerGoal', () => {
  const SK = 'sk_test_secret';
  const base = { serverKey: SK, sessionId: 'sess-1', name: 'purchase', dedupeKey: 'order_42' };
  const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  beforeEach(() => {
    // The suite runs under jsdom; a server has no window.
    vi.stubGlobal('window', undefined);
  });

  function okFetch() {
    return vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
  }
  function bodyOf(f: ReturnType<typeof vi.fn>, i = 0) {
    return JSON.parse((f.mock.calls[i]![1] as RequestInit).body as string);
  }

  it('uuidV5 matches the standard RFC-4122 vector (DNS namespace, python.org)', async () => {
    expect(await uuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('pure-JS SHA-1 fallback gives the same RFC vector and matches Web Crypto on odd lengths', async () => {
    const ns = Uint8Array.from('6ba7b8109dad11d180b400c04fd430c8'.match(/../g)!.map((h) => parseInt(h, 16)));
    const name = new TextEncoder().encode('python.org');
    const input = new Uint8Array(ns.length + name.length);
    input.set(ns); input.set(name, ns.length);
    const h = sha1Fallback(input).slice(0, 16);
    h[6] = (h[6]! & 0x0f) | 0x50; h[8] = (h[8]! & 0x3f) | 0x80;
    const x = Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(`${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
    // Node 18 (engines floor 18.18) has no unflagged globalThis.crypto, so an
    // unguarded loop threw there and failed the suite on the very runtime the
    // fallback exists for. The RFC vector above still pins the fallback.
    if (globalThis.crypto?.subtle) {
      for (const n of [0, 1, 55, 56, 63, 64, 65, 200]) {
        const buf = new Uint8Array(n).map((_, i) => (i * 7 + 3) & 255);
        const web = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', buf));
        expect(Array.from(sha1Fallback(buf))).toEqual(Array.from(web));
      }
    }
  });

  it('with no globalThis.crypto, trackServerGoal still sends the same goalId', async () => {
    const f1 = okFetch();
    await trackServerGoal({ ...base, fetch: f1 as unknown as typeof fetch });
    vi.stubGlobal('crypto', undefined);
    const f2 = okFetch();
    expect(await trackServerGoal({ ...base, fetch: f2 as unknown as typeof fetch })).toBe('recorded');
    expect(bodyOf(f2).goalId).toBe(bodyOf(f1).goalId);
  });

  it('a goal name containing ":" is failed with no request (id separator would collide)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = okFetch();
    expect(await trackServerGoal({ ...base, name: 'a:b', fetch: f as unknown as typeof fetch })).toBe('failed');
    expect(f).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('exports a namespace uuid', () => {
    expect(SERVER_GOAL_NAMESPACE).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('goalId is v5 over session:name:dedupeKey in the fixed namespace (pinned vector)', async () => {
    // Pinned so a change to the id derivation is a deliberate, visible break:
    // every stored server goal id is this hash, and a silent change would make
    // a retried webhook look like a new conversion to the goal_id check.
    const f = okFetch();
    await trackServerGoal({ ...base, fetch: f as unknown as typeof fetch });
    expect(bodyOf(f).goalId).toBe('8e95944e-57c0-5463-b417-1fd90aa76e05');
    expect(bodyOf(f).goalId).toBe(await uuidV5('sess-1:purchase:order_42', SERVER_GOAL_NAMESPACE));
  });

  it('two sessions with the same name + dedupeKey get different goalIds (cross-tenant collision)', async () => {
    // goal_events.goal_id is UNIQUE across every project and the insert is ON
    // CONFLICT DO NOTHING: when the id was hashed from name + dedupeKey only,
    // a second shop's order #1001 collided with the first shop's and was
    // silently dropped while still reporting 'recorded'.
    const f = okFetch();
    await trackServerGoal({ ...base, sessionId: 'shop-a-visitor', dedupeKey: '1001', fetch: f as unknown as typeof fetch });
    await trackServerGoal({ ...base, sessionId: 'shop-b-visitor', dedupeKey: '1001', fetch: f as unknown as typeof fetch });
    expect(bodyOf(f, 0).goalId).toMatch(UUID_V5);
    expect(bodyOf(f, 1).goalId).toMatch(UUID_V5);
    expect(bodyOf(f, 0).goalId).not.toBe(bodyOf(f, 1).goalId);
    // Retry dedupe for the same conversion still rides on externalId.
    expect(bodyOf(f, 0).externalId).toBe('1001');
  });

  it('same session + name + dedupeKey gives the same valid v5 goalId; different key differs', async () => {
    const f = okFetch();
    await trackServerGoal({ ...base, fetch: f as unknown as typeof fetch });
    await trackServerGoal({ ...base, fetch: f as unknown as typeof fetch });
    await trackServerGoal({ ...base, dedupeKey: 'order_43', fetch: f as unknown as typeof fetch });
    expect(bodyOf(f, 0).goalId).toMatch(UUID_V5);
    expect(bodyOf(f, 0).goalId).toBe(bodyOf(f, 1).goalId);
    expect(bodyOf(f, 2).goalId).not.toBe(bodyOf(f, 0).goalId);
  });

  it('posts the documented body with the server key as Bearer', async () => {
    const f = okFetch();
    const r = await trackServerGoal({
      ...base, value: 49.5, currency: 'USD', metadata: { plan: 'pro' },
      apiBaseUrl: 'https://api.example.com/v1', fetch: f as unknown as typeof fetch,
    });
    expect(r).toBe('recorded');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/goals');
    expect((init as RequestInit).method).toBe('POST');
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe(`Bearer ${SK}`);
    expect(bodyOf(f)).toEqual({
      sessionId: 'sess-1', name: 'purchase', goalId: expect.stringMatching(UUID_V5),
      externalId: 'order_42', value: 49.5, currency: 'USD', metadata: { plan: 'pro' },
    });
  });

  it('defaults to the production API base and omits unset optionals', async () => {
    const f = okFetch();
    await trackServerGoal({ ...base, fetch: f as unknown as typeof fetch });
    expect(f.mock.calls[0]![0]).toBe('https://api.sentient-ui.com/v1/goals');
    expect(Object.keys(bodyOf(f)).sort()).toEqual(['externalId', 'goalId', 'name', 'sessionId']);
  });

  it.each([null, undefined, ''])('sessionId %j is skipped_no_visitor with no request', async (sid) => {
    const f = okFetch();
    const r = await trackServerGoal({ ...base, sessionId: sid as string | null, fetch: f as unknown as typeof fetch });
    expect(r).toBe('skipped_no_visitor');
    expect(f).not.toHaveBeenCalled();
  });

  it('non-2xx is failed; a throwing fetch is failed (never throws)', async () => {
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
    expect(await trackServerGoal({ ...base, fetch: bad as unknown as typeof fetch })).toBe('failed');
    const boom = vi.fn().mockRejectedValue(new Error('net'));
    expect(await trackServerGoal({ ...base, fetch: boom as unknown as typeof fetch })).toBe('failed');
  });

  it('a fetch that never resolves is failed within timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const hang = vi.fn((_u: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
        }));
      const p = trackServerGoal({ ...base, timeoutMs: 200, fetch: hang as unknown as typeof fetch });
      await vi.advanceTimersByTimeAsync(250);
      expect(await p).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('in a browser: failed, no request, key never sent, one console.error', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('window', {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = okFetch();
    const r = await trackServerGoal({ ...base, fetch: f as unknown as typeof fetch });
    expect(r).toBe('failed');
    expect(f).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(err.mock.calls)).not.toContain(SK);
    err.mockRestore();
  });

  it('with only a userId, sends userId (no sessionId) and keys the goal id on the secret key', async () => {
    const f = okFetch();
    const res = await trackServerGoal({ serverKey: SK, userId: 'user_42', name: 'activated', dedupeKey: 'acct_9', fetch: f as unknown as typeof fetch });
    expect(res).toBe('recorded');
    const body = bodyOf(f);
    expect(body).not.toHaveProperty('sessionId');
    expect(body.userId).toBe('user_42');
    expect(body.goalId).toBe(await uuidV5(`user:${SK}:user_42:activated:acct_9`, SERVER_GOAL_NAMESPACE));
    // "42" exists in every tenant's database: another project's key must not
    // derive the same id (the bare goal_id unique would drop one silently).
    const g = okFetch();
    await trackServerGoal({ serverKey: 'sk_other_tenant', userId: 'user_42', name: 'activated', dedupeKey: 'acct_9', fetch: g as unknown as typeof fetch });
    expect(bodyOf(g).goalId).not.toBe(body.goalId);
  });

  it('a sessionId wins over a userId', async () => {
    const f = okFetch();
    await trackServerGoal({ ...base, userId: 'user_42', fetch: f as unknown as typeof fetch });
    expect(bodyOf(f).sessionId).toBe('sess-1');
    expect(bodyOf(f)).not.toHaveProperty('userId');
  });

  it('a userId no visit carries (404) is skipped_no_visitor, not failed', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    expect(await trackServerGoal({ serverKey: SK, userId: 'ghost', name: 'activated', dedupeKey: 'x', fetch: f as unknown as typeof fetch }))
      .toBe('skipped_no_visitor');
  });

  it('neither sessionId nor userId sends nothing', async () => {
    const f = okFetch();
    expect(await trackServerGoal({ serverKey: SK, sessionId: null, userId: '', name: 'activated', dedupeKey: 'x', fetch: f as unknown as typeof fetch }))
      .toBe('skipped_no_visitor');
    expect(f).not.toHaveBeenCalled();
  });
});


describe('signUserId (verified identify)', () => {
  // Pinned with node:crypto, and pinned to the SAME vector in the API's
  // lib/keys.test.ts — the two sides of verification must never drift.
  const SK = 'sk_test_identity_vector_000';
  const WANT = 'v1.1800000000.da00d5fc5a07e9a9b4cc1460694e3c298d308149e21fe0315585462e34be6e18';
  const at = { now: 1_800_000_000_000 - 86_400_000 }; // default 24 h -> exp 1800000000

  beforeEach(() => vi.stubGlobal('window', undefined));
  afterEach(() => vi.unstubAllGlobals());

  it('derives the secret from the sk_ and signs the user id (Web Crypto)', async () => {
    expect(await signUserId('user_42', SK, at)).toBe(WANT);
    // ttlSeconds moves the signed expiry.
    expect(await signUserId('user_42', SK, { ...at, ttlSeconds: 3600 })).toMatch(/^v1\.1799917200\.[0-9a-f]{64}$/);
    // Over the 7-day maximum is clamped, never minted to be refused.
    expect(await signUserId('user_42', SK, { ...at, ttlSeconds: 30 * 86_400 })).toMatch(/^v1\.1800518400\.[0-9a-f]{64}$/);
  });

  it('gives the same hash with no Web Crypto (Node 18) through the pure-JS SHA-256', async () => {
    vi.stubGlobal('crypto', undefined);
    expect(await signUserId('user_42', SK, at)).toBe(WANT);
  });

  it('pure-JS SHA-256 matches node:crypto across block boundaries', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
      const got = Array.from(sha256Fallback(data), (b) => b.toString(16).padStart(2, '0')).join('');
      expect(got, `length ${n}`).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });

  it('refuses to run in a browser (it needs the secret key)', async () => {
    vi.stubGlobal('window', {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await signUserId('user_42', SK, at)).toBe('');
    err.mockRestore();
  });
});
