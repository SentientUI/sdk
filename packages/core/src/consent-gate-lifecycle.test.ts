import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { grantConsent, init } from './index.js';
import { forgetVisitor } from './forget.js';
import { createEventQueue, retryStorageKey } from './queue.js';

const KEY = 'pk_test_lifecycle1';
const ok = (body: unknown = {}) => Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);

beforeEach(() => {
  delete (window as unknown as Record<string, unknown>).__sntForgetGen;
  localStorage.clear();
  sessionStorage.clear();
  document.cookie.split(';').forEach((c) => (document.cookie = `${c.split('=')[0]!.trim()}=; max-age=0; path=/`));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('gated decide is replayed on grant (audit N1)', () => {
  it('a decide asked while gated resolves with the real decision once consent arrives', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string) => (urls.push(String(u)), String(u).endsWith('/decide') ? ok({ slots: { hero: 'b' } }) : ok())));
    const client = init({ apiKey: KEY, consent: false });
    const pending = client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });
    await Promise.resolve();
    expect(urls.some((u) => u.endsWith('/decide'))).toBe(false); // nothing sent while gated
    grantConsent(KEY);
    await expect(pending).resolves.toMatchObject({ slots: { hero: 'b' } });
    client.dispose();
  });

  it('a gated decide from a page the visitor has left resolves null — no trial for slots off the page', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string) => (urls.push(String(u)), ok())));
    const client = init({ apiKey: KEY, consent: false });
    const pending = client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });
    window.history.pushState({}, '', '/elsewhere');
    grantConsent(KEY);
    await expect(pending).resolves.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(urls.some((u) => u.endsWith('/decide'))).toBe(false);
    client.dispose();
  });

  it('a never-granted gated client releases its held decides on dispose', async () => {
    vi.stubGlobal('fetch', vi.fn(() => ok()));
    const client = init({ apiKey: KEY, consent: false });
    const pending = client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });
    client.dispose();
    await expect(pending).resolves.toBeNull();
  });
});

describe('forgetVisitor (audit N2)', () => {
  it('deletes the identity, snapshot, retry buckets, assignments and graph cache; leaves other projects alone', () => {
    const sfx = KEY.slice(0, 12);
    document.cookie = `_snt_uid_${sfx}=abc; path=/`;
    localStorage.setItem(`_snt_uid_${sfx}`, 'abc');
    localStorage.setItem(`_snt_snap:${KEY}`, '{}');
    localStorage.setItem(`_snt_retry_${sfx}`, '[]');
    localStorage.setItem(`_snt_goal_retry_${sfx}`, '[]');
    localStorage.setItem(`_snt_asgn_${sfx}_hero:desktop`, '{}');
    localStorage.setItem(`_snt_graph_nodes_${sfx}`, '[]');
    localStorage.setItem('_snt_uid_pk_other_xxxx', 'keep');
    expect(forgetVisitor(KEY)).toBe(true);
    expect(document.cookie).not.toContain(`_snt_uid_${sfx}=`);
    expect(Object.keys(localStorage)).toEqual(['_snt_uid_pk_other_xxxx']);
  });

  it('a fresh visitor gets nothing written — not even the tombstone', () => {
    expect(forgetVisitor(KEY)).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('tombstones the shared legacy id so this project stops re-adopting it', () => {
    localStorage.setItem('_snt_uid', 'legacy');
    forgetVisitor(KEY);
    expect(localStorage.getItem('_snt_uid')).toBe('legacy');
    expect(localStorage.getItem(`_snt_uid_tomb_${KEY.slice(0, 12)}`)).toBe('1');
  });
});

describe('forget-me destroy never re-persists the retry bucket (audit N5)', () => {
  it('a failed final flush after destroy({ forget }) writes nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503 } as Response)));
    const q = createEventQueue({ ingestUrl: 'https://api.example.com/v1/events', apiKey: KEY });
    q.push({ id: 'e1', sessionId: 's', projectId: 'p', componentId: 'c', eventType: 'click', payload: {}, timestamp: 1, timeInSession: 0 } as never);
    q.destroy({ forget: true });
    localStorage.removeItem(retryStorageKey(KEY)); // what client.destroy() does right after
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.getItem(retryStorageKey(KEY))).toBeNull();
  });

  it('a plain destroy (dispose) still persists for retry', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503 } as Response)));
    const q = createEventQueue({ ingestUrl: 'https://api.example.com/v1/events', apiKey: KEY });
    q.push({ id: 'e1', sessionId: 's', projectId: 'p', componentId: 'c', eventType: 'click', payload: {}, timestamp: 1, timeInSession: 0 } as never);
    q.destroy();
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.getItem(retryStorageKey(KEY))).not.toBeNull();
  });
});

describe('regrade 3', () => {
  it('F1: a DNT/GPC-gated decide resolves null at once instead of hanging', async () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => true });
    try {
      vi.stubGlobal('fetch', vi.fn(() => ok()));
      const client = init({ apiKey: KEY, consent: true });
      await expect(client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] })).resolves.toBeNull();
      client.dispose();
    } finally {
      delete (navigator as unknown as { globalPrivacyControl?: unknown }).globalPrivacyControl;
    }
  });

  it('F2: destroy() on a never-granted client forgets a returning visitor\'s stored data', () => {
    const sfx = KEY.slice(0, 12);
    localStorage.setItem(`_snt_uid_${sfx}`, 'returning');
    localStorage.setItem(`_snt_snap:${KEY}`, '{}');
    const client = init({ apiKey: KEY, consent: false });
    client.destroy();
    expect(localStorage.getItem(`_snt_uid_${sfx}`)).toBeNull();
    expect(localStorage.getItem(`_snt_snap:${KEY}`)).toBeNull();
  });

  it('F8: after forget-me, a queue still draining never writes its retry bucket back', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503 } as Response)));
    const q = createEventQueue({ ingestUrl: 'https://api.example.com/v1/events', apiKey: KEY });
    q.push({ id: 'e1', sessionId: 's', projectId: 'p', componentId: 'c', eventType: 'click', payload: {}, timestamp: 1, timeInSession: 0 } as never);
    q.destroy(); // a pause: dispose-style flush, in flight
    forgetVisitor(KEY); // the refusal lands meanwhile
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.getItem(retryStorageKey(KEY))).toBeNull();
  });

  it('F9: a held decide survives an in-page anchor but not a hash-route change', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string) => (urls.push(String(u)), ok())));
    let client = init({ apiKey: KEY, consent: false });
    let pending = client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });
    window.location.hash = '#faq';
    grantConsent(KEY);
    await pending;
    expect(urls.some((u) => u.endsWith('/decide'))).toBe(true);
    client.dispose();
    urls.length = 0;
    window.location.hash = '#/home';
    client = init({ apiKey: KEY, consent: false });
    pending = client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });
    window.location.hash = '#/pricing';
    grantConsent(KEY);
    await expect(pending).resolves.toBeNull();
    expect(urls.some((u) => u.endsWith('/decide'))).toBe(false);
    client.dispose();
    window.location.hash = '';
  });

  it('forgetVisitor tombstones a legacy id held only in sessionStorage', () => {
    sessionStorage.setItem('_snt_uid', 'legacy');
    forgetVisitor(KEY);
    expect(localStorage.getItem(`_snt_uid_tomb_${KEY.slice(0, 12)}`)).toBe('1');
  });
});

describe('regrade 4', () => {
  it('NEW-1: a goal fired while consent is pending is held and sent on grant', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string, init?: RequestInit) => {
      if (String(u).endsWith('/goals')) bodies.push(String(init?.body));
      return ok();
    }));
    const client = init({ apiKey: KEY, consent: false });
    expect(client.gated).toBe(true);
    client.goal('purchase', { value: 42 });
    await new Promise((r) => setTimeout(r, 0));
    expect(bodies).toHaveLength(0); // nothing sent while gated
    grantConsent(KEY);
    await vi.waitFor(() => expect(bodies.some((b) => b.includes('purchase'))).toBe(true));
    expect(client.gated).toBe(false);
    client.dispose();
  });

  it('NEW-1: held goals are dropped when consent never comes (dispose) — nothing is sent', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string) => (urls.push(String(u)), ok())));
    const client = init({ apiKey: KEY, consent: false });
    client.goal('purchase');
    client.dispose();
    grantConsent(KEY);
    await new Promise((r) => setTimeout(r, 0));
    expect(urls.some((u) => u.endsWith('/goals'))).toBe(false);
  });

  it('NEW-1: under DNT/GPC nothing is held at all', async () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => true });
    try {
      const urls: string[] = [];
      vi.stubGlobal('fetch', vi.fn((u: string) => (urls.push(String(u)), ok())));
      const client = init({ apiKey: KEY, consent: true });
      client.goal('purchase');
      grantConsent(KEY);
      await new Promise((r) => setTimeout(r, 0));
      expect(urls).toEqual([]);
      client.dispose();
    } finally {
      delete (navigator as unknown as { globalPrivacyControl?: unknown }).globalPrivacyControl;
    }
  });

  it('NEW-3: a decide in flight when the visitor is forgotten never writes the snapshot back', async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn((u: string) =>
      String(u).endsWith('/decide')
        ? new Promise<Response>((r) => (answer = r))
        : ok(),
    ));
    const client = init({ apiKey: KEY, consent: true });
    const p = client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });
    await vi.waitFor(() => expect(answer).toBeDefined());
    client.destroy();
    answer({ ok: true, status: 200, json: async () => ({ slots: { hero: 'b' }, persona: 'admin', confidence: 0.9 }) } as Response);
    await p;
    expect(localStorage.getItem(`_snt_snap:${KEY}`)).toBeNull();
  });
});

describe('regrade 6', () => {
  it('NEW-1: a PAUSED client\'s in-flight decide never writes the visitor back after forget + re-grant', async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn((u: string) => (String(u).endsWith('/decide') ? new Promise<Response>((r) => (answer = r)) : ok())));
    const paused = init({ apiKey: KEY, consent: true });
    const p = paused.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });
    await vi.waitFor(() => expect(answer).toBeDefined());
    paused.dispose(); // banner reopened: a pause, identity kept
    forgetVisitor(KEY); // then a refusal
    const regranted = init({ apiKey: KEY, consent: true }); // then an accept
    answer({ ok: true, status: 200, json: async () => ({ slots: { hero: 'b' }, persona: 'admin', confidence: 0.9 }) } as Response);
    await p;
    expect(localStorage.getItem(`_snt_snap:${KEY}`)).toBeNull();
    regranted.dispose();
  });

  it('NEW-2: a decide waiting on the session is not sent after the visitor withdraws', async () => {
    let sessionDone!: (r: Response) => void;
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string) => {
      urls.push(String(u));
      return String(u).endsWith('/sessions') ? new Promise<Response>((r) => (sessionDone = r)) : ok();
    }));
    const client = init({ apiKey: KEY, consent: true });
    const p = client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] });
    const a = client.assign('cta', ['x', 'y']);
    await vi.waitFor(() => expect(sessionDone).toBeDefined());
    client.destroy();
    sessionDone({ ok: true, status: 200, json: async () => ({}) } as Response);
    await expect(p).resolves.toBeNull();
    await expect(a).resolves.toBeNull();
    expect(urls.some((u) => u.endsWith('/decide') || u.endsWith('/assign'))).toBe(false);
  });
});

describe('held conversions keep their count (grader NEW-3)', () => {
  it('two held add_to_cart goals are two goals after the grant', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string, init?: RequestInit) => {
      if (String(u).endsWith('/goals')) bodies.push(String(init?.body));
      return ok();
    }));
    const client = init({ apiKey: KEY, consent: false });
    client.goal('add_to_cart');
    client.goal('add_to_cart');
    grantConsent(KEY);
    await vi.waitFor(() => expect(bodies.filter((b) => b.includes('add_to_cart'))).toHaveLength(2));
    client.dispose();
  });
});

describe('regrade 7 lifecycle', () => {
  it('N7-3: goals fired AFTER a refusal are never sent, even on a later accept', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string, init?: RequestInit) => {
      if (String(u).endsWith('/goals')) bodies.push(String(init?.body));
      return ok();
    }));
    const client = init({ apiKey: KEY, consent: false });
    client.destroy(); // a refusal
    expect(client.released).toBe(true);
    client.goal('after_refusal');
    await expect(client.decide({ slots: [{ id: 'hero', arms: ['a', 'b'] }] })).resolves.toBeNull();
    // A later accept starts a NEW client: the released one stays released.
    const fresh = init({ apiKey: KEY, consent: false });
    grantConsent(KEY);
    fresh.goal('after_accept');
    await new Promise((r) => setTimeout(r, 20));
    expect(bodies.some((b) => b.includes('after_refusal'))).toBe(false);
    expect(bodies.some((b) => b.includes('after_accept'))).toBe(true);
    fresh.dispose();
  });

  it('N7-6: a destroyed client stops retrying the session upsert and sends nothing more', async () => {
    vi.useFakeTimers();
    try {
      const urls: string[] = [];
      vi.stubGlobal('fetch', vi.fn((u: string) => (urls.push(String(u)), Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as Response))));
      const client = init({ apiKey: KEY, consent: true });
      await vi.advanceTimersByTimeAsync(0);
      client.destroy();
      const before = urls.filter((u) => u.endsWith('/sessions')).length;
      client.goal('x');
      client.identify('u1');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(urls.filter((u) => u.endsWith('/sessions')).length).toBe(before);
      expect(urls.some((u) => u.endsWith('/goals'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('regrade 8 lifecycle', () => {
  it('#6: a released gated client is out of the grantConsent() registry — a global grant never revives it', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string) => (urls.push(String(u)), ok())));
    const warn = vi.mocked(console.warn);
    const client = init({ apiKey: KEY, consent: false });
    client.dispose(); // a pause: its owner let it go
    grantConsent(KEY);
    await new Promise((r) => setTimeout(r, 20));
    expect(client.gated).toBe(true); // never upgraded
    expect(urls.some((u) => u.endsWith('/sessions'))).toBe(false); // no orphan tracking client
    expect(warn.mock.calls.some((c) => String(c[0]).includes('client released before consent'))).toBe(true);
  });

  it('#6: disposing an OLD gated client leaves a newer one under the same key upgradeable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => ok()));
    const old = init({ apiKey: KEY, consent: false });
    const next = init({ apiKey: KEY, consent: false });
    old.dispose();
    grantConsent(KEY);
    expect(next.gated).toBe(false);
    next.dispose();
  });

  it('#3: componentGoal sends nothing once the visitor is forgotten elsewhere (another bundle, a CMP refusal)', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string, init?: RequestInit) => {
      bodies.push(`${String(u)} ${String(init?.body ?? '')}`);
      return String(u).endsWith('/assign') ? ok({ variantId: 'b', assignmentTtlMs: 60_000, sessionId: 's1' }) : ok({ sessionId: 's1' });
    }));
    const client = init({ apiKey: KEY, consent: true });
    await client.assign('hero', ['a', 'b']);
    // Control: attributed and sent while the visitor is tracked.
    client.componentGoal('hero', 'before_forget');
    await new Promise((r) => setTimeout(r, 20));
    client.flush();
    await new Promise((r) => setTimeout(r, 20));
    expect(bodies.some((b) => b.includes('before_forget'))).toBe(true);
    forgetVisitor(KEY);
    client.componentGoal('hero', 'after_forget');
    await new Promise((r) => setTimeout(r, 20));
    client.flush();
    await new Promise((r) => setTimeout(r, 20));
    expect(bodies.some((b) => b.includes('after_forget'))).toBe(false);
    client.dispose();
  });
});

describe('regrade 11 lifecycle', () => {
  it('N11-3: a goal fired right after the grant is sent AFTER the goals held before it', async () => {
    const names: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string, init?: RequestInit) => {
      if (String(u).endsWith('/goals')) names.push((JSON.parse(String(init?.body)) as { name: string }).name);
      return ok({ sessionId: 's1' });
    }));
    const client = init({ apiKey: KEY, consent: false });
    client.goal('first');
    client.goal('second');
    grantConsent(KEY);
    client.goal('third');
    await new Promise((r) => setTimeout(r, 50));
    expect(names).toEqual(['first', 'second', 'third']);
    client.dispose();
  });
});

