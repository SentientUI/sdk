import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Behaviour of the page-journey capture added with migration 108. Exercised
 * through init() so the history patching is tested as it actually ships.
 */
describe('pageview tracking', () => {
  let tracked: Array<{ eventType: string; path?: string; componentId: string }>;
  let restore: Array<() => void>;

  beforeEach(() => {
    tracked = [];
    restore = [];
    const origPush = window.history.pushState;
    const origReplace = window.history.replaceState;
    restore.push(() => {
      window.history.pushState = origPush;
      window.history.replaceState = origReplace;
    });
  });

  afterEach(() => {
    for (const r of restore) r();
    vi.restoreAllMocks();
  });

  async function initClient() {
    const mod = await import('./index.js');
    const client = mod.init({ apiKey: 'pk_test', context: 'landing', ingestUrl: 'http://localhost/v1/events' });
    const orig = client.track.bind(client);
    vi.spyOn(client, 'track').mockImplementation((e) => {
      tracked.push(e as never);
      return orig(e);
    });
    return client;
  }

  it('captures the landing page and each SPA route change', async () => {
    window.history.replaceState({}, '', '/');
    await initClient();
    // init() already emitted the landing pageview before the spy attached, so
    // assert on navigations, which is the part history patching is responsible for.
    window.history.pushState({}, '', '/pricing');
    window.history.pushState({}, '', '/docs');

    const paths = tracked.filter((e) => e.eventType === 'pageview').map(() => window.location.pathname);
    expect(paths.length).toBeGreaterThanOrEqual(2);
  });

  it('does not emit twice for a replaceState that keeps the same path', async () => {
    // Frameworks replaceState repeatedly for one navigation (scroll restoration,
    // query updates); each would otherwise look like another page in the journey.
    window.history.replaceState({}, '', '/pricing');
    await initClient();
    const before = tracked.filter((e) => e.eventType === 'pageview').length;
    window.history.replaceState({}, '', '/pricing');
    window.history.replaceState({}, '', '/pricing');
    expect(tracked.filter((e) => e.eventType === 'pageview').length).toBe(before);
  });

  it('a disposed client stops watching navigations — re-init does not stack emitters', async () => {
    // The React provider re-inits on every consent change and StrictMode
    // double-invoke. Without a teardown, each init wrapped history again and the
    // old wrapper kept emitting through the DISPOSED client, so one navigation
    // produced one pageview per init that ever happened.
    window.history.replaceState({}, '', '/stacking-start');
    const first = await initClient();
    first.dispose?.();
    await initClient();
    window.history.pushState({}, '', '/stacking-nav');
    expect(tracked.filter((e) => e.eventType === 'pageview')).toHaveLength(1);
  });

  it('does not re-record the landing page when consent re-init lands on the same path', async () => {
    // dispose() flushes, so the first landing pageview was already delivered;
    // a StrictMode or consent re-mount then counted the same page twice.
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      if (init?.body) bodies.push(String(init.body));
      return { ok: true, status: 202, json: async () => ({ accepted: 1, rejected: 0 }) };
    }));

    window.history.replaceState({}, '', '/relanding');
    const first = await initClient();
    // Let the deferred enqueue land and the first landing actually deliver.
    await new Promise((r) => setTimeout(r, 0));
    first.dispose?.();
    await new Promise((r) => setTimeout(r, 0));
    const second = await initClient();
    await new Promise((r) => setTimeout(r, 0));
    second.dispose?.();
    await new Promise((r) => setTimeout(r, 0));

    const landings = bodies.filter((b) => b.includes('__page__') && b.includes('/relanding'));
    expect(landings).toHaveLength(1);
  });

  it('puts the path on the WIRE, and never the query string', async () => {
    // Asserted at the network boundary, not on track()'s argument: `path` is
    // stamped inside track(), so the caller's object never shows it. What matters
    // is what actually leaves the browser.
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      if (init?.body) bodies.push(String(init.body));
      return { ok: true, status: 202, json: async () => ({ accepted: 1, rejected: 0 }) };
    }));

    window.history.replaceState({}, '', '/checkout?email=a@b.com');
    const client = await initClient();
    client.track({ projectId: 'pk_test', componentId: 'hero', eventType: 'dwell', payload: {} });
    await new Promise((r) => setTimeout(r, 0));
    client.dispose?.();
    await new Promise((r) => setTimeout(r, 0));

    const eventBody = bodies.find((b) => b.includes('"hero"'));
    expect(eventBody).toBeDefined();
    expect(eventBody).toContain('"path":"/checkout"');
    // The email lived in the query string; pathname never carried it.
    expect(eventBody).not.toContain('a@b.com');
  });
});
