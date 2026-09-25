import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consentWatcher as realWatcher, forgetVisitor as realForget } from '@sentientui/core/consent';
import { run } from './index';
import { _resetConsentLazy } from './consent-lazy';

// Real core, and the consent chunk NOT pre-loaded — the production shape.
// run.test.ts pre-loads the chunk, which is how the grader's N1 (a consented
// visitor never decided) and N2 (a boot-time refusal never forgot) hid.

const KEY = 'pk_test_consentboot';
const w = window as unknown as Record<string, unknown>;
const calls: string[] = [];
let decideGoals: unknown[] = [];
let decideStatus = 200;
let decideDelay = 0;
let decideBody: Record<string, unknown> | null = null;

function loadChunk(): void {
  const tag = Array.from(document.head.querySelectorAll('script')).find((s) => s.src.endsWith('consent.global.js'));
  expect(tag, 'the snippet asked for the consent chunk').toBeTruthy();
  w.__sentientConsent = { consentWatcher: realWatcher, forgetVisitor: realForget };
  tag!.onload!(new Event('load'));
}

beforeEach(() => {
  _resetConsentLazy();
  localStorage.clear();
  sessionStorage.clear();
  calls.length = 0;
  decideGoals = [];
  decideStatus = 200;
  decideBody = null;
  decideDelay = 0;
  window.history.replaceState({}, '', '/');
  document.head.innerHTML = '';
  document.body.innerHTML = '<section id="hero">Hi</section>';
  const self = document.createElement('script');
  self.src = 'https://cdn.example/@sentientui/snippet/dist/snippet.global.js';
  document.body.appendChild(self);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string) => {
      calls.push(String(u));
      if (String(u).endsWith('/decide') && decideDelay) await new Promise((r) => setTimeout(r, decideDelay));
      if (String(u).endsWith('/decide') && decideStatus !== 200) return { ok: false, status: decideStatus, json: async () => ({}) } as Response;
      const body = String(u).endsWith('/decide')
        ? decideBody ?? { layoutOrder: null, assignments: {}, slots: { hero: { tone: 'urgent' } }, persona: 'unknown', confidence: 0, goals: decideGoals }
        : String(u).endsWith('/registry/locators')
          ? { slots: [{ id: 'hero', locator: null }] }
          : {};
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  // Tear down the previous test's live client, or its queue flushes into the next test.
  (w.SentientSnippet as { revokeConsent?: () => void } | undefined)?.revokeConsent?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete w.__sentientConsent;
  delete w.Cookiebot;
  delete w.sentient;
});

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('snippet + lazy consent presets, real core', () => {
  it('an already-consented visitor is decided once the chunk lands (N1)', async () => {
    w.Cookiebot = { consent: { statistics: true } };
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot', slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } } };
    const booted = run();
    await settle();
    expect(calls.some((u) => u.endsWith('/decide'))).toBe(false); // gated until the platform is readable
    loadChunk();
    await booted;
    await settle();
    expect(calls.some((u) => u.endsWith('/decide'))).toBe(true);
    await vi.waitFor(() => expect(document.getElementById('hero')!.getAttribute('data-tone')).toBe('urgent'));
  });

  it('a refusal already on record at boot forgets the stored visitor (N2)', async () => {
    const sfx = KEY.slice(0, 12);
    localStorage.setItem(`_snt_uid_${sfx}`, 'old-visitor');
    localStorage.setItem(`_snt_snap:${KEY}`, JSON.stringify({ v: 1 }));
    w.Cookiebot = { consent: { statistics: false }, hasResponse: true };
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot' };
    void run();
    await settle();
    loadChunk();
    await settle();
    expect(localStorage.getItem(`_snt_uid_${sfx}`)).toBeNull();
    expect(localStorage.getItem(`_snt_snap:${KEY}`)).toBeNull();
    expect(calls.filter((u) => /\/v1\/(decide|sessions|events)/.test(u))).toEqual([]);
  });

  it('an unresolvable chunk URL stays gated and says so (review M1)', async () => {
    document.body.innerHTML = '<section id="hero">Hi</section>';
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot' };
    void run();
    await settle();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('tracking stays off'));
    expect(calls.filter((u) => /\/v1\/(decide|sessions|events)/.test(u))).toEqual([]);
  });

  it('editor goals are wired once a late consent lets the decide through (grader N-A)', async () => {
    decideGoals = [{ goalId: 'home_seen', event: 'url_reached', urlPattern: '/' }];
    w.Cookiebot = { consent: { statistics: true } };
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot' };
    const booted = run();
    await settle();
    loadChunk();
    await booted;
    await settle();
    await vi.waitFor(() => expect(calls.some((u) => u.endsWith('/goals'))).toBe(true));
  });

  it('consent granted after an SPA navigation decides the CURRENT route (grader N-C)', async () => {
    w.Cookiebot = { consent: { statistics: true } };
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot' };
    const booted = run();
    await settle();
    window.history.pushState({}, '', '/pricing'); // the held decide was for '/'
    loadChunk();
    await booted;
    await settle();
    await vi.waitFor(() => expect(calls.filter((u) => u.endsWith('/decide'))).toHaveLength(1));
    await settle();
    expect(calls.filter((u) => u.endsWith('/decide'))).toHaveLength(1); // the route decide, never the dropped one too
  });

  it('a manual gate\'s Reject, before any grant, forgets a returning visitor (grader F2)', async () => {
    const sfx = KEY.slice(0, 12);
    localStorage.setItem(`_snt_uid_${sfx}`, 'returning');
    localStorage.setItem(`_snt_snap:${KEY}`, JSON.stringify({ v: 1 }));
    w.sentient = { apiKey: KEY, consent: false };
    void run();
    await settle();
    (w.SentientSnippet as { revokeConsent(): void }).revokeConsent();
    expect(localStorage.getItem(`_snt_uid_${sfx}`)).toBeNull();
    expect(localStorage.getItem(`_snt_snap:${KEY}`)).toBeNull();
  });

  it('a gated boot never applies the stored snapshot (grader F3)', async () => {
    localStorage.setItem(`_snt_snap:${KEY}`, JSON.stringify({ v: 1, persona: 'admin', band: 'high', slots: { hero: { tone: 'urgent' } }, layoutOrder: null, savedAt: Date.now() }));
    w.sentient = { apiKey: KEY, consent: false, slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } } };
    void run();
    await settle();
    expect(document.getElementById('hero')!.getAttribute('data-tone')).toBeNull();
  });

  it('grant after navigating to a page with no component still wires goals, and never paints stale snapshot copy (review #1/#2, grader F7)', async () => {
    decideGoals = [{ goalId: 'pricing_seen', event: 'url_reached', urlPattern: '/pricing' }];
    decideBody = { layoutOrder: null, assignments: {}, slots: {}, persona: 'unknown', confidence: 0, goals: decideGoals };
    w.Cookiebot = { consent: { statistics: true } };
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot' };
    const booted = run();
    await settle();
    window.history.pushState({}, '', '/pricing');
    loadChunk();
    await booted;
    await vi.waitFor(() => expect(calls.filter((u) => u.endsWith('/decide'))).toHaveLength(1));
    await vi.waitFor(() => expect(calls.some((u) => u.endsWith('/goals'))).toBe(true));
  });

  it('a replayed decide that FAILS on the same page is not sent again (grader F6)', async () => {
    decideStatus = 500;
    w.Cookiebot = { consent: { statistics: true } };
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot' };
    const booted = run();
    await settle();
    loadChunk();
    await booted;
    await settle();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.filter((u) => u.endsWith('/decide'))).toHaveLength(1);
  });

  it('revokeConsent after a pause still forgets (review #3)', async () => {
    const sfx = KEY.slice(0, 12);
    w.Cookiebot = { consent: { statistics: true } };
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot' };
    const booted = run();
    await settle();
    loadChunk();
    await booted;
    await settle();
    expect(localStorage.getItem(`_snt_uid_${sfx}`)).not.toBeNull();
    // Paused (no answer in memory), then the site's own forget-me button.
    w.Cookiebot = { consent: { statistics: false }, hasResponse: false };
    window.dispatchEvent(new Event('CookiebotOnLoad'));
    (w.SentientSnippet as { revokeConsent(): void }).revokeConsent();
    expect(localStorage.getItem(`_snt_uid_${sfx}`)).toBeNull();
  });

  it('a goal fired before the consent chunk lands reaches /goals once consent is known (grader NEW-1)', async () => {
    w.Cookiebot = { consent: { statistics: true } };
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot' };
    const booted = run();
    await settle();
    (w.SentientSnippet as { goal(n: string, o?: unknown): void }).goal('purchase', { value: 42 });
    expect(calls.some((u) => u.endsWith('/goals'))).toBe(false);
    loadChunk();
    await booted;
    await vi.waitFor(() => expect(calls.some((u) => u.endsWith('/goals'))).toBe(true));
  });

  it('hash routers: consent after an in-app navigation decides the current route (grader NEW-2)', async () => {
    window.history.replaceState({}, '', '/app/#/home');
    w.Cookiebot = { consent: { statistics: true } };
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot' };
    const booted = run();
    await settle();
    window.location.hash = '#/pricing';
    loadChunk();
    await booted;
    await vi.waitFor(() => expect(calls.filter((u) => u.endsWith('/decide'))).toHaveLength(1));
  });

  it('a failed first decide: the next navigation decides that page (grader NEW-6)', async () => {
    decideStatus = 500;
    w.sentient = { apiKey: KEY };
    await run();
    await settle();
    expect(calls.filter((u) => u.endsWith('/decide'))).toHaveLength(1);
    decideStatus = 200;
    window.history.pushState({}, '', '/next');
    await new Promise((r) => setTimeout(r, 120)); // the SPA hook's debounce
    await vi.waitFor(() => expect(calls.filter((u) => u.endsWith('/decide'))).toHaveLength(2));
  });

  it('a navigation while the first decide is in flight sends no second decide (grader F1)', async () => {
    decideDelay = 80;
    w.sentient = { apiKey: KEY };
    const booted = run();
    await settle();
    window.history.pushState({}, '', '/elsewhere');
    await new Promise((r) => setTimeout(r, 70)); // SPA hook debounce, decide still pending
    await booted;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.filter((u) => u.endsWith('/decide'))).toHaveLength(1);
  });

  it('a deferred apply (document still loading) never loops decides (grader F1)', async () => {
    const rs = Object.getOwnPropertyDescriptor(Document.prototype, 'readyState')!;
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'loading' });
    try {
      w.sentient = { apiKey: KEY, slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } } };
      void run();
      await new Promise((r) => setTimeout(r, 150));
      expect(calls.filter((u) => u.endsWith('/decide')).length).toBeLessThanOrEqual(1);
    } finally {
      delete (document as unknown as { readyState?: unknown }).readyState;
      void rs;
      document.dispatchEvent(new Event('DOMContentLoaded'));
    }
  });

  it('a refusal before any grant drops held goals — a later accept does not send them (grader F4)', async () => {
    w.Cookiebot = { consent: { statistics: false }, hasResponse: true };
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot' };
    void run();
    await settle();
    (w.SentientSnippet as { goal(n: string): void }).goal('before_refusal');
    loadChunk();
    await settle();
    w.Cookiebot = { consent: { statistics: true }, hasResponse: true };
    window.dispatchEvent(new Event('CookiebotOnAccept'));
    await settle();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.some((u) => u.endsWith('/goals'))).toBe(false);
  });

  it('revoke then re-grant during the first decide never writes the forgotten visitor back (review #3)', async () => {
    decideDelay = 60;
    w.sentient = { apiKey: KEY, slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } } };
    const booted = run();
    await settle();
    const api = w.SentientSnippet as { revokeConsent(): void; grantConsent(): void };
    api.revokeConsent();
    api.grantConsent();
    await booted;
    await new Promise((r) => setTimeout(r, 120));
    const snap = localStorage.getItem(`_snt_snap:${KEY}`);
    // Only a decision made for the NEW visitor may be stored.
    expect(calls.filter((u) => u.endsWith('/decide')).length).toBeGreaterThanOrEqual(1);
    if (snap) expect(JSON.parse(snap).savedAt).toBeGreaterThan(0);
  });

  it('a failed first decide is not re-sent by repeated grantConsent() calls (review #2)', async () => {
    decideStatus = 500;
    w.sentient = { apiKey: KEY };
    await run();
    await settle();
    const api = w.SentientSnippet as { grantConsent(): void };
    api.grantConsent();
    api.grantConsent();
    await settle();
    expect(calls.filter((u) => u.endsWith('/decide'))).toHaveLength(1);
  });

  it('pause → grant while the first decide is in flight still gets the page decided (grader SN-1)', async () => {
    decideDelay = 60;
    w.Cookiebot = { consent: { statistics: true }, hasResponse: true };
    document.cookie = `CookieConsent=${encodeURIComponent("{stamp:'x',necessary:true,preferences:true,statistics:true,marketing:true}")}; path=/`;
    w.__sentientConsent = { consentWatcher: realWatcher, forgetVisitor: realForget };
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot', slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } } };
    const booted = run();
    await settle();
    // Banner reopened (no answer in memory): a pause, identity kept.
    w.Cookiebot = { consent: { statistics: false }, hasResponse: false };
    document.cookie = 'CookieConsent=; max-age=0; path=/';
    window.dispatchEvent(new Event('CookiebotOnLoad'));
    // Closed unchanged: granted again.
    w.Cookiebot = { consent: { statistics: true }, hasResponse: true };
    window.dispatchEvent(new Event('CookiebotOnAccept'));
    await booted;
    await vi.waitFor(() => expect(document.getElementById('hero')!.getAttribute('data-tone')).toBe('urgent'), { timeout: 2000 });
  });

  it('refusal on record, then an accept on the same page: the page gets decided (grader N7-4)', async () => {
    w.Cookiebot = { consent: { statistics: false }, hasResponse: true };
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot', slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } } };
    void run();
    await settle();
    loadChunk();
    await settle();
    expect(calls.filter((u) => u.endsWith('/decide'))).toHaveLength(0);
    w.Cookiebot = { consent: { statistics: true }, hasResponse: true };
    window.dispatchEvent(new Event('CookiebotOnAccept'));
    await vi.waitFor(() => expect(calls.filter((u) => u.endsWith('/decide'))).toHaveLength(1));
    await vi.waitFor(() => expect(document.getElementById('hero')!.getAttribute('data-tone')).toBe('urgent'));
  });

  it('manual revoke then grant before any answer: the page gets decided (review R7 #2)', async () => {
    w.sentient = { apiKey: KEY, consent: false, slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } } };
    void run();
    await settle();
    const api = w.SentientSnippet as { revokeConsent(): void; grantConsent(): void };
    api.revokeConsent();
    api.grantConsent();
    await vi.waitFor(() => expect(calls.filter((u) => u.endsWith('/decide')).length).toBeGreaterThanOrEqual(1));
    await vi.waitFor(() => expect(document.getElementById('hero')!.getAttribute('data-tone')).toBe('urgent'));
  });

  it('an answer discarded under 5 s after pause→regrant still gets the page decided (grader N7-2)', async () => {
    decideDelay = 40;
    w.sentient = { apiKey: KEY, consent: true, slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } } };
    const booted = run();
    await settle();
    // A pause (not a forget) then a re-grant while the first decide is in flight.
    const api = w.SentientSnippet as { grantConsent(): void };
    (w.SentientSnippet as { revokeConsent(): void }).revokeConsent();
    api.grantConsent();
    await booted;
    await vi.waitFor(() => expect(document.getElementById('hero')!.getAttribute('data-tone')).toBe('urgent'), { timeout: 2000 });
  });

  it('pause → reject → accept never writes the refused-era decision back (review R7 #1)', async () => {
    w.Cookiebot = { consent: { statistics: true }, hasResponse: true };
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot', slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } } };
    const booted = run();
    await settle();
    loadChunk();
    await booted;
    await vi.waitFor(() => expect(localStorage.getItem(`_snt_snap:${KEY}`)).not.toBeNull());
    w.Cookiebot = { consent: { statistics: false }, hasResponse: false }; // pause
    window.dispatchEvent(new Event('CookiebotOnLoad'));
    w.Cookiebot = { consent: { statistics: false }, hasResponse: true }; // reject
    window.dispatchEvent(new Event('CookiebotOnDecline'));
    expect(localStorage.getItem(`_snt_snap:${KEY}`)).toBeNull();
    w.Cookiebot = { consent: { statistics: true }, hasResponse: true }; // accept
    window.dispatchEvent(new Event('CookiebotOnAccept'));
    await new Promise((r) => setTimeout(r, 100));
    // The page was already decided; nothing may write the refused-era state back.
    expect(localStorage.getItem(`_snt_snap:${KEY}`)).toBeNull();
  });

  it('a TRUE pause (banner reopened, not a forget) mid first decide, then re-grant: decided, same visitor (grader R8)', async () => {
    decideDelay = 40;
    w.Cookiebot = { consent: { statistics: true }, hasResponse: true };
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot', slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } } };
    const booted = run();
    await settle();
    loadChunk();
    await vi.waitFor(() => expect(calls.some((u) => u.endsWith('/decide'))).toBe(true));
    const sfx = KEY.slice(0, 12);
    const uid = localStorage.getItem(`_snt_uid_${sfx}`);
    expect(uid).toBeTruthy();
    w.Cookiebot = { consent: { statistics: false }, hasResponse: false }; // banner reopened
    window.dispatchEvent(new Event('CookiebotOnLoad'));
    w.Cookiebot = { consent: { statistics: true }, hasResponse: true }; // closed unchanged
    window.dispatchEvent(new Event('CookiebotOnAccept'));
    await booted;
    await vi.waitFor(() => expect(document.getElementById('hero')!.getAttribute('data-tone')).toBe('urgent'), { timeout: 2000 });
    expect(localStorage.getItem(`_snt_uid_${sfx}`)).toBe(uid); // a pause keeps the identity
  });

  it('a refusal of a tracked visitor forgets exactly once, not again on the next platform signal (review R8 #4)', async () => {
    w.Cookiebot = { consent: { statistics: true }, hasResponse: true };
    w.sentient = { apiKey: KEY, consentFrom: 'cookiebot' };
    const booted = run();
    await settle();
    loadChunk();
    await booted;
    await settle();
    const gen = () => ((w.__sntForgetGen as Record<string, number> | undefined) ?? {})[KEY] ?? 0;
    const before = gen();
    w.Cookiebot = { consent: { statistics: false }, hasResponse: true };
    window.dispatchEvent(new Event('CookiebotOnDecline'));
    const afterRefusal = gen();
    expect(afterRefusal).toBeGreaterThan(before);
    window.dispatchEvent(new Event('CookiebotOnLoad'));
    window.dispatchEvent(new Event('CookiebotOnDecline'));
    expect(gen()).toBe(afterRefusal);
  });

  it('a custom banner reset (cookie deleted) after an accept pauses tracking, keeping the visitor (grader N11-2)', async () => {
    document.cookie = 'site_consent=yes; path=/';
    w.sentient = { apiKey: KEY, consentFrom: { cookie: 'site_consent', value: 'yes', event: 'site-consent' } };
    const booted = run();
    await settle();
    loadChunk();
    await booted;
    await settle();
    const api = w.SentientSnippet as { goal(n: string): void };
    const sfx = KEY.slice(0, 12);
    const uid = localStorage.getItem(`_snt_uid_${sfx}`);
    expect(uid).toBeTruthy();
    document.cookie = 'site_consent=; max-age=0; path=/';
    window.dispatchEvent(new Event('site-consent'));
    const before = calls.filter((u) => u.endsWith('/goals')).length;
    api.goal('after_reset');
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((u) => u.endsWith('/goals')).length).toBe(before);
    expect(localStorage.getItem(`_snt_uid_${sfx}`)).toBe(uid); // a pause, not a forget
  });
});

