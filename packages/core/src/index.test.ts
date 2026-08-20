import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { init, grantConsent } from './index.js';

const BASE_CONFIG = {
  apiKey: 'pk_test_abc123',
  ingestUrl: 'https://api.example.com/v1/events',
  context: 'saas' as const,
};

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('init() apiKey validation', () => {
  // 0.10.0: a missing/invalid key defaults to keyless LOCAL MODE (spec:
  // Rung 0's 60-second path). The old silent-no-op-with-warning contract is
  // preserved behind localMode: false.
  it('returns the local-mode client when apiKey is empty (keyless default)', async () => {
    const client = init({ ...BASE_CONFIG, apiKey: '' });
    expect(client.isLocal).toBe(true);
    client.destroy();
  });

  it('returns no-op client and warns when apiKey is empty and localMode is false', async () => {
    const client = init({ ...BASE_CONFIG, apiKey: '', localMode: false });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('invalid apiKey'));
    expect(await client.assign('comp', [])).toBeNull();
  });

  it('returns no-op client and warns when apiKey lacks pk_ prefix and localMode is false', async () => {
    const client = init({ ...BASE_CONFIG, apiKey: 'sk_live_bad', localMode: false });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('invalid apiKey'));
    expect(await client.assign('comp', [])).toBeNull();
  });

  it('returns no-op client and warns when ingestUrl is empty', async () => {
    const client = init({ ...BASE_CONFIG, ingestUrl: '' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ingestUrl'));
    expect(await client.assign('comp', [])).toBeNull();
  });

  it('initializes normally with a valid pk_ key and ingestUrl', () => {
    const client = init({ ...BASE_CONFIG });
    expect(console.warn).not.toHaveBeenCalled();
    expect(client).toBeDefined();
    client.destroy();
  });
});

describe('init() assign() fallback on server errors', () => {
  it('returns null when assign endpoint responds 404', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true })           // session upsert
      .mockResolvedValueOnce({ ok: false, status: 404 }), // assign
    );

    const client = init({ ...BASE_CONFIG });
    const result = await client.assign('hero', ['v1', 'v2']);
    expect(result).toBeNull();
    client.destroy();
  });

  it('returns null when fetch rejects with a network error', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true })                  // session upsert
      .mockRejectedValueOnce(new Error('network down')),    // assign
    );

    const client = init({ ...BASE_CONFIG });
    const result = await client.assign('hero', ['v1', 'v2']);
    expect(result).toBeNull();
    client.destroy();
  });
});

describe('init() with consent: false', () => {
  it('returns no-op client when consent is false and no preConsentBehavior', async () => {
    const client = init({ ...BASE_CONFIG, consent: false });
    expect(await client.assign('hero', ['A', 'B'])).toBeNull();
    // fetch should not have been called (no session, no winner call)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('calls /v1/winner when consent is false and preConsentBehavior is statistical_winner', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ variantId: 'B' }),
    }));

    const client = init({
      ...BASE_CONFIG,
      consent: false,
      preConsentBehavior: 'statistical_winner',
    });

    const result = await client.assign('hero', ['A', 'B']);
    expect(result).toEqual({ variantId: 'B', assignmentTtlMs: 0 });

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain('/winner');
    expect(String(url)).toContain('componentId=hero');
  });

  it('falls back to first variantId when /v1/winner returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const client = init({
      ...BASE_CONFIG,
      consent: false,
      preConsentBehavior: 'statistical_winner',
    });

    const result = await client.assign('hero', ['A', 'B']);
    expect(result).toEqual({ variantId: 'A', assignmentTtlMs: 0 });
  });

  it('no-ops track, goal, identify when pre-consent', () => {
    const client = init({
      ...BASE_CONFIG,
      consent: false,
      preConsentBehavior: 'statistical_winner',
    });
    // none of these throw, none call fetch
    client.track({ componentId: 'hero', variantId: 'A', eventType: 'variant_assigned', projectId: 'p', payload: {} });
    client.goal('signup');
    client.identify('user-123');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('init() Do Not Track', () => {
  beforeEach(() => {
    document.cookie = '_snt_uid=; max-age=0; path=/';
    document.cookie = '_snt_uid_probe=; max-age=0; path=/';
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  // The session cookie is `_snt_uid=<uuid>`; assert against the `=` so we don't
  // false-match the `_snt_uid_probe` writability probe cookie.

  afterEach(() => {
    Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: undefined, configurable: true });
  });

  it('does not track or set cookies when DNT is enabled, even with consent: true', async () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    const client = init({ ...BASE_CONFIG, consent: true });
    expect(await client.assign('hero', ['A', 'B'])).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(document.cookie).not.toMatch(/_snt_uid=[^;]/);
  });

  it('still serves the read-only statistical winner under DNT without setting cookies', async () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ variantId: 'B' }) }));
    const client = init({ ...BASE_CONFIG, consent: true, preConsentBehavior: 'statistical_winner' });
    const result = await client.assign('hero', ['A', 'B']);
    expect(result).toEqual({ variantId: 'B', assignmentTtlMs: 0 });
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain('/winner');
    expect(document.cookie).not.toMatch(/_snt_uid=[^;]/);
  });

  it('grantConsent() does not upgrade tracking while DNT is enabled', async () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ variantId: 'B' }) }));
    const client = init({ ...BASE_CONFIG, apiKey: 'pk_dnt_upgrade1', consent: false, preConsentBehavior: 'statistical_winner' });
    grantConsent('pk_dnt_upgrade1');
    await client.assign('hero', ['A', 'B']);
    // Every call must be the read-only /winner endpoint — never the tracking /assign endpoint.
    expect(vi.mocked(fetch).mock.calls.every(([u]) => String(u).includes('/winner'))).toBe(true);
  });

  it('recognises the legacy "yes" DNT value', async () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: 'yes', configurable: true });
    const client = init({ ...BASE_CONFIG, consent: true });
    expect(await client.assign('hero', ['A', 'B'])).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('tracks normally when DNT is enabled but respectDoNotTrack is false', () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    const client = init({ ...BASE_CONFIG, respectDoNotTrack: false });
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes('/sessions'))).toBe(true);
    // The visitor-id cookie is namespaced per project (see storage-key.ts).
    expect(document.cookie).toMatch(/_snt_uid_[^=;]+=[^;]/);
    client.destroy();
  });

  // audit P3: GPC (Global Privacy Control) is the legally-enforceable CCPA/CPRA
  // opt-out and must gate tracking exactly like DNT, even with consent: true.
  it('honors Global Privacy Control (navigator.globalPrivacyControl) as an opt-out', async () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    const client = init({ ...BASE_CONFIG, consent: true });
    expect(await client.assign('hero', ['A', 'B'])).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(document.cookie).not.toMatch(/_snt_uid=[^;]/);
  });

  // audit P2: the local-mode branch used to run before the DNT/consent gate, so
  // createLocalModeClient() set the 365-day _snt_uid cookie for opted-out
  // visitors on sites with a missing/invalid key.
  it('does not set the identity cookie in keyless local mode when DNT is enabled', async () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    const client = init({ ...BASE_CONFIG, apiKey: 'not-a-valid-key', localMode: 'auto', consent: true });
    expect(await client.assign('hero', ['A', 'B'])).toBeNull();
    expect(document.cookie).not.toMatch(/_snt_uid=[^;]/);
  });
});

describe('grantConsent()', () => {
  it('upgrades the pre-consent proxy to the full client', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ variantId: 'A' }) }) // winner call
      .mockResolvedValueOnce({ ok: true })                                           // session upsert
      .mockResolvedValueOnce({ ok: true, json: async () => ({ variantId: 'B', assignmentTtlMs: 30000 }) }), // assign
    );

    const client = init({
      ...BASE_CONFIG,
      consent: false,
      preConsentBehavior: 'statistical_winner',
    });

    // Pre-consent: calls /winner
    const preResult = await client.assign('hero', ['A', 'B']);
    expect(preResult?.variantId).toBe('A');
    const winnerCall = String(vi.mocked(fetch).mock.calls[0]![0]);
    expect(winnerCall).toContain('/winner');

    // Grant consent — upgrades the proxy in place
    grantConsent();

    // Post-consent: same client reference now calls /assign
    const postResult = await client.assign('pricing', ['X', 'Y']);
    expect(postResult?.variantId).toBe('B');
    const assignCall = String(vi.mocked(fetch).mock.calls[2]![0]);
    expect(assignCall).toContain('/assign');

    client.destroy();
  });

  it('is a no-op when called before init()', () => {
    expect(() => grantConsent()).not.toThrow();
  });

  // 'control' is the documented default and the only pre-consent mode that
  // makes no network call. It used to register `upgrade: null`, so a site that
  // wanted zero pre-consent traffic could never start tracking without a full
  // reload — and grantConsent() failed silently.
  it('upgrades a control-mode pre-consent client, with no request before consent', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true })                                                          // session upsert
      .mockResolvedValueOnce({ ok: true, json: async () => ({ variantId: 'B', assignmentTtlMs: 30000 }) }), // assign
    );

    // Distinct key + component ids: the assignment cache is keyed on
    // (apiKey, componentId, variantIds) and persists in localStorage across
    // tests in this file, so reusing them would serve a cached variant and
    // skip the fetch this test is asserting on.
    const client = init({
      ...BASE_CONFIG,
      apiKey: 'pk_ctrl_upgrade1',
      consent: false,
      preConsentBehavior: 'control',
    });

    // Pre-consent: serves the control variant locally, touches the network zero times.
    expect(await client.assign('ctrl_hero', ['A', 'B'])).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    grantConsent();

    // Same client reference is now live.
    const postResult = await client.assign('ctrl_pricing', ['X', 'Y']);
    expect(postResult?.variantId).toBe('B');
    // Order isn't pinned: the session upsert is fire-and-forget and can land
    // after the assign, so match any call rather than the last one.
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/assign'))).toBe(true);

    client.destroy();
  });

  it('upgrades a control-mode client when preConsentBehavior is omitted', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ variantId: 'B', assignmentTtlMs: 30000 }) }),
    );

    const client = init({ ...BASE_CONFIG, apiKey: 'pk_ctrl_upgrade2', consent: false });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    grantConsent();

    expect((await client.assign('ctrl_default', ['X', 'Y']))?.variantId).toBe('B');
    client.destroy();
  });

  it('does not upgrade a control-mode client while DNT is enabled', async () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    const client = init({ ...BASE_CONFIG, apiKey: 'pk_ctrl_dnt1', consent: false, preConsentBehavior: 'control' });

    grantConsent();

    expect(await client.assign('ctrl_dnt_hero', ['A', 'B'])).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });
    client.destroy();
  });
});

describe('assign() agentData passthrough', () => {
  it('includes agentData in the /assign request body when provided', async () => {
    // The beforeEach stub already mocks fetch. Add specific return values on top.
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true } as Response)   // session upsert
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ variantId: 'B', assignmentTtlMs: 30000 }),
      } as Response);

    const client = init({ ...BASE_CONFIG });
    await client.assign('hero-agent', ['A', 'B'], { headline: 'Ship faster' });

    const assignCall = vi.mocked(fetch).mock.calls.find(([url]) =>
      String(url).includes('/assign'),
    );
    expect(assignCall).toBeDefined();
    const bodyStr = (assignCall![1] as RequestInit).body as string;
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    expect(body.agentData).toEqual({ headline: 'Ship faster' });

    client.destroy();
  });

  it('omits agentData from /assign body when not provided', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true } as Response)   // session upsert
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ variantId: 'A', assignmentTtlMs: 30000 }),
      } as Response);

    const client = init({ ...BASE_CONFIG });
    await client.assign('pricing-agent', ['A', 'B']);

    const assignCall = vi.mocked(fetch).mock.calls.find(([url]) =>
      String(url).includes('/assign'),
    );
    expect(assignCall).toBeDefined();
    const body = JSON.parse((assignCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.agentData).toBeUndefined();

    client.destroy();
  });
});

describe('assign() inflight dedup', () => {
  it('coalesces concurrent assign() for the same component into one fetch', async () => {
    let resolveAssign: (v: Response) => void = () => undefined;
    const assignPromise = new Promise<Response>((r) => { resolveAssign = r; });

    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/sessions')) return Promise.resolve({ ok: true } as Response);
      // /assign — return the pending promise so both callers share it.
      return assignPromise;
    }));

    const client = init({ ...BASE_CONFIG });
    const p1 = client.assign('dup', ['A', 'B']);
    const p2 = client.assign('dup', ['A', 'B']);

    resolveAssign({ ok: true, json: async () => ({ variantId: 'B', assignmentTtlMs: 0 }) } as Response);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1?.variantId).toBe('B');
    expect(r2?.variantId).toBe('B');

    const assignCalls = vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/assign'));
    expect(assignCalls).toHaveLength(1);

    client.destroy();
  });

  it('allows a fresh assign() for the same component after the inflight one settles', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/sessions')) return Promise.resolve({ ok: true } as Response);
      return Promise.resolve({ ok: true, json: async () => ({ variantId: 'A', assignmentTtlMs: 0 }) } as Response);
    }));

    const client = init({ ...BASE_CONFIG });
    await client.assign('seq', ['A', 'B']);
    // Cache now holds the result; a second call with variantIds returns the cache hit
    // without another /assign fetch. Use a managed (no variantIds) component to force
    // a fresh request and prove the inflight map was cleared.
    await client.assign('managed-x');
    await client.assign('managed-x');

    const managedCalls = vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/assign'));
    // managed-x has no content cached, so each call fetches again (2 calls) — proving
    // the inflight entry was deleted in the finally block after the first settled.
    expect(managedCalls.length).toBeGreaterThanOrEqual(2);

    client.destroy();
  });
});

describe('assign() agentDataByVariant precedence', () => {
  it('prefers agentDataByVariant over agentData in the /assign body', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ variantId: 'A', assignmentTtlMs: 0 }) } as Response);

    const client = init({ ...BASE_CONFIG });
    await client.assign('hero', ['A', 'B'], { fallback: 'x' }, { A: { headline: 'one' }, B: { headline: 'two' } });

    const assignCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes('/assign'));
    const body = JSON.parse((assignCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.agentDataByVariant).toEqual({ A: { headline: 'one' }, B: { headline: 'two' } });
    expect(body.agentData).toBeUndefined();

    client.destroy();
  });

  it('falls back to agentData when agentDataByVariant is undefined', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ variantId: 'A', assignmentTtlMs: 0 }) } as Response);

    const client = init({ ...BASE_CONFIG });
    await client.assign('hero2', ['A', 'B'], { headline: 'solo' });

    const assignCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes('/assign'));
    const body = JSON.parse((assignCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.agentData).toEqual({ headline: 'solo' });
    expect(body.agentDataByVariant).toBeUndefined();

    client.destroy();
  });
});

describe('assign() honors server assignmentTtlMs', () => {
  it('stores the server TTL and surfaces the remaining TTL on a later cache hit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (String(url).includes('/sessions')) return Promise.resolve({ ok: true } as Response);
        return Promise.resolve({ ok: true, json: async () => ({ variantId: 'B', assignmentTtlMs: 60_000 }) } as Response);
      }));

      const client = init({ ...BASE_CONFIG, apiKey: 'pk_ttl_surface1' });
      // Unique componentId so a prior test's persisted assignment can't cache-hit.
      const first = await client.assign('hero-ttl-surface', ['A', 'B']);
      expect(first).toEqual({ variantId: 'B', assignmentTtlMs: 60_000 });

      // 20s later a cache hit must report the remaining 40s, not the old hardcoded 0.
      vi.setSystemTime(20_000);
      const second = await client.assign('hero-ttl-surface', ['A', 'B']);
      expect(second?.assignmentTtlMs).toBe(40_000);
      expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/assign'))).toHaveLength(1);

      client.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cache hit for an entry with no server TTL still surfaces 0', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/sessions')) return Promise.resolve({ ok: true } as Response);
      return Promise.resolve({ ok: true, json: async () => ({ variantId: 'A', assignmentTtlMs: 0 }) } as Response);
    }));

    const client = init({ ...BASE_CONFIG, apiKey: 'pk_ttl_surface2' });
    await client.assign('hero-ttl-none', ['A', 'B']);
    const hit = await client.assign('hero-ttl-none', ['A', 'B']);
    expect(hit?.assignmentTtlMs).toBe(0);
    client.destroy();
  });
});

describe('init() re-init disposes the prior client (no leaked timer/listeners)', () => {
  it('tears down the previous client bound to the same apiKey on a second init()', () => {
    const key = 'pk_reinit_leak01';
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const removeDocSpy = vi.spyOn(document, 'removeEventListener');
    const removeWinSpy = vi.spyOn(window, 'removeEventListener');

    const c1 = init({ ...BASE_CONFIG, apiKey: key });
    const clearsBefore = clearSpy.mock.calls.length;

    const c2 = init({ ...BASE_CONFIG, apiKey: key });

    // The first client's queue interval was cleared and its unload listeners removed.
    expect(clearSpy.mock.calls.length).toBeGreaterThan(clearsBefore);
    expect(removeDocSpy.mock.calls.some(([e]) => e === 'visibilitychange')).toBe(true);
    expect(removeWinSpy.mock.calls.some(([e]) => e === 'pagehide')).toBe(true);

    // c1 was superseded; disposing it again is a harmless no-op.
    expect(() => c1.dispose()).not.toThrow();
    c2.destroy();
  });
});

describe('fetchWeights() resilience', () => {
  it('returns [] when res.json() throws (malformed JSON)', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/sessions')) return Promise.resolve({ ok: true } as Response);
      if (String(url).includes('/weights')) {
        return Promise.resolve({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } } as unknown as Response);
      }
      return Promise.resolve({ ok: true } as Response);
    }));

    const client = init({ ...BASE_CONFIG });
    const weights = await client.fetchWeights();
    expect(weights).toEqual([]);

    client.destroy();
  });

  it('returns [] when the weights endpoint responds non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/sessions')) return Promise.resolve({ ok: true } as Response);
      if (String(url).includes('/weights')) return Promise.resolve({ ok: false, status: 500 } as Response);
      return Promise.resolve({ ok: true } as Response);
    }));

    const client = init({ ...BASE_CONFIG });
    expect(await client.fetchWeights()).toEqual([]);
    client.destroy();
  });

  it('returns data.components when present', async () => {
    const components = [{ componentId: 'hero', updatedAt: 1, variants: [{ variantId: 'A', pulls: 5, avgReward: 0.2 }] }];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/sessions')) return Promise.resolve({ ok: true } as Response);
      if (String(url).includes('/weights')) return Promise.resolve({ ok: true, json: async () => ({ components }) } as Response);
      return Promise.resolve({ ok: true } as Response);
    }));

    const client = init({ ...BASE_CONFIG });
    expect(await client.fetchWeights()).toEqual(components);
    client.destroy();
  });
});

describe('destroy() — forget-me teardown', () => {
  it('removes the decision snapshot and retry queue, not just the identity keys', () => {
    const client = init({ ...BASE_CONFIG });
    // Simulate state left by earlier visits: a persona/slot snapshot (read by
    // the pre-paint script on the next visit) and a persisted retry bucket.
    localStorage.setItem(
      `_snt_snap:${BASE_CONFIG.apiKey}`,
      JSON.stringify({ v: 1, persona: 'buyer', band: 'high', slots: {}, layoutOrder: null, savedAt: 1 }),
    );
    localStorage.setItem('_snt_retry_pk_test_abc1', '[]');

    client.destroy();

    // README: "deletes the visitor identity … and all local storage". A
    // surviving snapshot would re-personalize the next visit after forget-me.
    expect(localStorage.getItem(`_snt_snap:${BASE_CONFIG.apiKey}`)).toBeNull();
    expect(localStorage.getItem('_snt_retry_pk_test_abc1')).toBeNull();
  });
});

describe('dispose() — routine cleanup teardown', () => {
  it('stops the client but keeps identity, snapshot, and retry bucket (unlike destroy)', () => {
    const client = init({ ...BASE_CONFIG });
    localStorage.setItem(
      `_snt_snap:${BASE_CONFIG.apiKey}`,
      JSON.stringify({ v: 1, persona: 'buyer', band: 'high', slots: {}, layoutOrder: null, savedAt: 1 }),
    );
    localStorage.setItem('_snt_retry_pk_test_abc1', '[]');

    client.dispose();

    // dispose is for provider unmount / re-init — the visitor must survive it.
    // Only destroy() (consent revocation) removes identity and local state.
    expect(document.cookie).toContain('_snt_uid');
    expect(localStorage.getItem(`_snt_snap:${BASE_CONFIG.apiKey}`)).not.toBeNull();
    expect(localStorage.getItem('_snt_retry_pk_test_abc1')).not.toBeNull();
  });
});

describe('readUtmParams via session upsert body', () => {
  async function captureSessionBody(search: string): Promise<Record<string, unknown>> {
    const original = window.location;
    // jsdom won't let us redefine location.search alone; replace the whole object
    // with a minimal stub exposing the fields init() reads.
    Object.defineProperty(window, 'location', {
      value: { search, origin: original.origin, href: original.href },
      configurable: true,
      writable: true,
    });
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
      const client = init({ ...BASE_CONFIG });
      const sessionCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes('/sessions'));
      const body = JSON.parse((sessionCall![1] as RequestInit).body as string) as Record<string, unknown>;
      client.destroy();
      return body;
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true, writable: true });
    }
  }

  it('extracts only utm_-prefixed params', async () => {
    const body = await captureSessionBody('?utm_source=google&utm_medium=cpc&ref=abc&gclid=123');
    expect(body.utmParams).toEqual({ utm_source: 'google', utm_medium: 'cpc' });
  });

  it('returns empty object for a query string with no utm params', async () => {
    const body = await captureSessionBody('?foo=bar&baz=qux');
    expect(body.utmParams).toEqual({});
  });

  it('decodes percent-encoded and non-ASCII utm values', async () => {
    const body = await captureSessionBody('?utm_campaign=' + encodeURIComponent('café été') + '&utm_term=a%20b');
    expect(body.utmParams).toEqual({ utm_campaign: 'café été', utm_term: 'a b' });
  });

  it('keeps empty-valued utm params as empty strings', async () => {
    const body = await captureSessionBody('?utm_source=&utm_medium=email');
    expect(body.utmParams).toEqual({ utm_source: '', utm_medium: 'email' });
  });

  it('returns empty object for an empty query string', async () => {
    const body = await captureSessionBody('');
    expect(body.utmParams).toEqual({});
  });
});

describe('automation flag in session upsert body', () => {
  async function captureSessionBody(): Promise<Record<string, unknown>> {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const client = init({ ...BASE_CONFIG });
    const sessionCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes('/sessions'));
    const body = JSON.parse((sessionCall![1] as RequestInit).body as string) as Record<string, unknown>;
    client.destroy();
    return body;
  }

  it('sends automation:false for a normal human browser', async () => {
    Object.defineProperty(navigator, 'webdriver', { value: false, configurable: true });
    const body = await captureSessionBody();
    expect(body.automation).toBe(false);
  });

  it('sends automation:true when navigator.webdriver is set', async () => {
    Object.defineProperty(navigator, 'webdriver', { value: true, configurable: true });
    try {
      const body = await captureSessionBody();
      expect(body.automation).toBe(true);
    } finally {
      Object.defineProperty(navigator, 'webdriver', { value: false, configurable: true });
    }
  });
});

describe('event id fallback when crypto.randomUUID throws', () => {
  it('still produces a valid RFC4122-v4 session goal id when randomUUID throws', async () => {
    const goalBodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, opts?: RequestInit) => {
      if (String(url).includes('/goals')) {
        goalBodies.push(JSON.parse(opts!.body as string) as Record<string, unknown>);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    }));

    const realUUID = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', {
      value: () => { throw new Error('blocked by policy'); },
      configurable: true,
    });

    try {
      const client = init({ ...BASE_CONFIG });
      client.goal('signup');
      // goal() fires inside sessionReady.then(); wait for the /goals call to land.
      await vi.waitFor(() => expect(goalBodies).toHaveLength(1));

      const id = goalBodies[0]!.goalId as string;
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

      client.destroy();
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: realUUID, configurable: true });
    }
  });
});

describe('grantConsent() with multiple init() calls', () => {
  it('upgrades only the matching client when apiKey is passed to grantConsent', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValue({ ok: true, json: async () => ({ variantId: 'winner' }) });
    vi.stubGlobal('fetch', fetchMock);

    // Init two separate pre-consent projects
    init({ ...BASE_CONFIG, apiKey: 'pk_aaaaaaaaa001', consent: false, preConsentBehavior: 'statistical_winner' });
    const clientB = init({ ...BASE_CONFIG, apiKey: 'pk_bbbbbbbbb001', consent: false, preConsentBehavior: 'statistical_winner' });

    // Grant consent only for project A
    grantConsent('pk_aaaaaaaaa001');

    // clientB should still be the pre-consent proxy — assign goes to /winner, not /assign
    await clientB.assign('hero', ['v1', 'v2']);
    const calls = fetchMock.mock.calls.map(([url]) => url as string);
    const winnerCalls = calls.filter((u) => u.includes('/winner'));
    expect(winnerCalls.length).toBeGreaterThan(0);

    clientB.destroy();
  });

  it('grantConsent() with no args does not throw', () => {
    init({ ...BASE_CONFIG, apiKey: 'pk_cccccccc001', consent: false, preConsentBehavior: 'statistical_winner' });
    expect(() => grantConsent()).not.toThrow();
  });
});

describe('init() country field in session upsert', () => {
  it('includes country in the session upsert when provided', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    init({
      apiKey: 'pk_test_country',
      context: 'saas',
      country: 'DE',
      ingestUrl: 'https://api.sentient-ui.com/v1/events',
    });

    // Wait for the session upsert micro-task to flush
    await new Promise((r) => setTimeout(r, 0));

    const sessionCall = calls.find((c) =>
      typeof c.body === 'string' && JSON.parse(c.body).sessionId !== undefined,
    );
    expect(sessionCall).toBeDefined();
    expect(JSON.parse(sessionCall!.body as string).country).toBe('DE');
  });
});

describe('componentGoal()', () => {
  // Capture events posted to the ingest (/events) endpoint.
  function captureEvents(): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn((url: string, opts?: RequestInit) => {
      if (String(url).includes('/events') && opts?.body) {
        for (const e of JSON.parse(opts.body as string) as Array<Record<string, unknown>>) {
          events.push(e);
        }
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    }));
    return events;
  }

  // sessionReady.then(push) runs on a microtask; a macrotask tick guarantees it
  // has landed, then destroy() flushes the queued batch to the fetch stub.
  async function flush(client: ReturnType<typeof init>): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    client.destroy();
    await new Promise((r) => setTimeout(r, 0));
  }

  it('records a component-attributed goal_achieved event for the served variant', async () => {
    const events = captureEvents();
    // Seed the served variant via initialAssignments so no /assign round trip is needed.
    const client = init({ ...BASE_CONFIG, initialAssignments: { hero_headline: 'B' } });

    client.componentGoal('hero_headline', 'hero_contact', { reward: 1, metadata: { method: 'whatsapp' } });
    await flush(client);

    const goals = events.filter((e) => e.eventType === 'goal_achieved');
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({
      componentId: 'hero_headline',
      variantId: 'B',
      eventType: 'goal_achieved',
      goalType: 'hero_contact',
      projectId: BASE_CONFIG.apiKey,
    });
    expect(goals[0]!.payload).toMatchObject({ reward: 1, method: 'whatsapp' });
  });

  it('defaults reward to 1 when no options are given', async () => {
    const events = captureEvents();
    const client = init({ ...BASE_CONFIG, initialAssignments: { pricing: 'annual' } });

    client.componentGoal('pricing', 'subscribe');
    await flush(client);

    const goals = events.filter((e) => e.eventType === 'goal_achieved');
    expect(goals).toHaveLength(1);
    expect(goals[0]!.payload).toEqual({ reward: 1 });
  });

  it('no-ops when the component has no assignment yet', async () => {
    const events = captureEvents();
    const client = init({ ...BASE_CONFIG }); // nothing assigned

    client.componentGoal('never_rendered', 'hero_contact');
    await flush(client);

    expect(events.filter((e) => e.eventType === 'goal_achieved')).toHaveLength(0);
  });
});

describe('goal() options object (revenue values, spec §5)', () => {
  function captureGoalBodies(): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn((url: string, opts?: RequestInit) => {
      if (String(url).includes('/goals') && opts?.body) {
        bodies.push(JSON.parse(opts.body as string) as Record<string, unknown>);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    }));
    return bodies;
  }

  it('sends value/currency/externalId on the wire', async () => {
    const bodies = captureGoalBodies();
    const client = init({ ...BASE_CONFIG, apiKey: 'pk_goalopts_001' });
    client.goal('purchase', { value: 129.99, currency: 'EUR', externalId: 'order_1042' });
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      name: 'purchase', value: 129.99, currency: 'EUR', externalId: 'order_1042',
      weight: 1, stepIndex: 0, metadata: {},
    });
    client.destroy();
  });

  it('treats an object with only foreign keys as legacy metadata', async () => {
    const bodies = captureGoalBodies();
    const client = init({ ...BASE_CONFIG, apiKey: 'pk_goalopts_002' });
    client.goal('signup', { plan: 'pro' });
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]!.metadata).toEqual({ plan: 'pro' });
    expect(bodies[0]!.value).toBeUndefined();
    client.destroy();
  });

  it('reserved keys switch interpretation to options (legacy metadata.value was inert)', async () => {
    const bodies = captureGoalBodies();
    const client = init({ ...BASE_CONFIG, apiKey: 'pk_goalopts_003' });
    client.goal('purchase', { value: 42 });
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]!.value).toBe(42);
    expect(bodies[0]!.metadata).toEqual({});
    client.destroy();
  });

  it('positional legacy signature still works', async () => {
    const bodies = captureGoalBodies();
    const client = init({ ...BASE_CONFIG, apiKey: 'pk_goalopts_004' });
    client.goal('step', { foo: 1 }, 0.4, 2);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ weight: 0.4, stepIndex: 2, metadata: { foo: 1 } });
    expect(bodies[0]!.value).toBeUndefined();
    client.destroy();
  });

  it('options-object weight/stepIndex win over positional defaults', async () => {
    const bodies = captureGoalBodies();
    const client = init({ ...BASE_CONFIG, apiKey: 'pk_goalopts_005' });
    client.goal('step', { weight: 0.3, stepIndex: 1, metadata: { a: 1 } });
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ weight: 0.3, stepIndex: 1, metadata: { a: 1 } });
    client.destroy();
  });
});

describe('componentGoal() value passthrough (spec §5)', () => {
  function captureEvents(): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn((url: string, opts?: RequestInit) => {
      if (String(url).includes('/events') && opts?.body) {
        for (const e of JSON.parse(opts.body as string) as Array<Record<string, unknown>>) {
          events.push(e);
        }
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    }));
    return events;
  }

  async function flush(client: ReturnType<typeof init>): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    client.destroy();
    await new Promise((r) => setTimeout(r, 0));
  }

  it('puts goalValue and currency in the event payload', async () => {
    const events = captureEvents();
    const client = init({ ...BASE_CONFIG, apiKey: 'pk_cgval_001', initialAssignments: { checkout: 'B' } });
    client.componentGoal('checkout', 'purchase', { value: 129.99, currency: 'USD' });
    await flush(client);
    const goals = events.filter((e) => e.eventType === 'goal_achieved');
    expect(goals).toHaveLength(1);
    expect(goals[0]!.payload).toMatchObject({ reward: 1, goalValue: 129.99, currency: 'USD' });
  });

  it('omits goalValue when no value is given (binary goal unchanged)', async () => {
    const events = captureEvents();
    const client = init({ ...BASE_CONFIG, apiKey: 'pk_cgval_002', initialAssignments: { checkout: 'B' } });
    client.componentGoal('checkout', 'purchase');
    await flush(client);
    const goals = events.filter((e) => e.eventType === 'goal_achieved');
    expect(goals[0]!.payload).toEqual({ reward: 1 });
  });
});
