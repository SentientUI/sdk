import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readSnapshot, writeSnapshot } from '@sentientui/core';
import { run, reapply, parsePreview, parseEditorToken, parsePersonaPreview } from './index';

vi.mock('@sentientui/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentientui/core')>();
  return { ...actual, init: vi.fn() };
});
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn(() => () => undefined) }));
// Mock per-option slot signals so a test can observe the cleanup being invoked
// (the real detachers bind DOM listeners we can't otherwise inspect).
vi.mock('./slot-signals', () => ({ attachSlotSignals: vi.fn(() => vi.fn()) }));
import { init } from '@sentientui/core';
import { startEngagementCapture } from '@sentientui/core/engagement';
import { attachSlotSignals } from './slot-signals';
const mockInit = vi.mocked(init);
const mockCapture = vi.mocked(startEngagementCapture);
const mockAttachSlot = vi.mocked(attachSlotSignals);

declare global {
  interface Window { sentient?: unknown }
}

function resetDom(): void {
  localStorage.clear();
  sessionStorage.clear();
  delete (window as unknown as { __sentientEditor?: unknown }).__sentientEditor;
  document.getElementById('sentient-editor-load-notice')?.remove();
  document.body.innerHTML = '<section id="hero"></section>';
  for (const attr of ['data-sentient-persona', 'data-sentient-confidence', 'data-tone']) {
    document.documentElement.removeAttribute(attr);
  }
  document.getElementById('hero')!.removeAttribute('data-tone');
}

const CONFIG = {
  apiKey: 'pk_test',
  context: 'landing',
  personaAttributes: true,
  slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } },
};

/** Published locators the stubbed GET /v1/registry/locators serves. Default:
 *  one `hero` component with `locator: null` (targets <html>, so it is always
 *  on the page) — registry-mode tests below that predate page scoping decide
 *  `hero` exactly as before. `null` makes the request fail. */
let publishedLocators: Array<{ id: string; kind: string; locator: unknown }> | null;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  resetDom();
  (window as Window).sentient = CONFIG;
  publishedLocators = [{ id: 'hero', kind: 'arms', locator: null }];
  // Registry mode now fetches locators before deciding; never hit the network.
  fetchMock.mockImplementation(async (url: string) =>
    url.endsWith('/v1/registry/locators') && publishedLocators
      ? { ok: true, json: async () => ({ slots: publishedLocators }) }
      : url.endsWith('/v1/locator-miss')
        ? { ok: true, json: async () => ({}) }
        : Promise.reject(new Error('offline')),
  );
  vi.stubGlobal('fetch', fetchMock);
});

describe('run — success path', () => {
  it('applies persona attrs + slot dims and writes the snapshot', async () => {
    mockInit.mockReturnValue({
      decide: vi.fn().mockResolvedValue({
        layoutOrder: null,
        assignments: {},
        slots: { hero: { tone: 'urgent' } },
        persona: 'admin',
        confidence: 0.8,
      }),
      getPersona: vi.fn().mockReturnValue({ persona: 'admin', confidence: 0.8, band: 'high' }),
    } as never);

    await run();

    expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('admin');
    expect(document.documentElement.getAttribute('data-sentient-confidence')).toBe('high');
    expect(document.getElementById('hero')!.getAttribute('data-tone')).toBe('urgent');

    const snap = readSnapshot('pk_test');
    expect(snap).not.toBeNull();
    expect(snap!.slots).toEqual({ hero: { tone: 'urgent' } });
    expect(snap!.persona).toBe('admin');
  });
});

describe('run — fail-safe', () => {
  it('leaves the DOM untouched when decide rejects', async () => {
    mockInit.mockReturnValue({
      decide: vi.fn().mockRejectedValue(new Error('network down')),
      getPersona: vi.fn().mockReturnValue(null),
    } as never);

    await expect(run()).resolves.toBeUndefined(); // never throws
    expect(document.documentElement.getAttribute('data-sentient-persona')).toBeNull();
    expect(document.getElementById('hero')!.getAttribute('data-tone')).toBeNull();
    expect(readSnapshot('pk_test')).toBeNull();
  });

  it('leaves the DOM untouched when init itself throws', async () => {
    mockInit.mockImplementation(() => { throw new Error('boom'); });
    await expect(run()).resolves.toBeUndefined();
    expect(document.getElementById('hero')!.getAttribute('data-tone')).toBeNull();
  });

  it('does nothing when window.sentient is missing or invalid', async () => {
    (window as Window).sentient = undefined;
    await run();
    expect(mockInit).not.toHaveBeenCalled();
  });
});

describe('run — window.SentientSnippet global', () => {
  function mockDecided() {
    const decide = vi.fn().mockResolvedValue({
      layoutOrder: null, assignments: {},
      slots: { hero: { tone: 'urgent' } }, persona: 'admin', confidence: 0.8,
    });
    mockInit.mockReturnValue({
      decide,
      getPersona: vi.fn().mockReturnValue({ persona: 'admin', confidence: 0.8, band: 'high' }),
      goal: vi.fn(), componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);
    return decide;
  }

  it('exposes the goal-wiring API and getState reflects the decision', async () => {
    mockDecided();
    await run();
    const api = (window as unknown as { SentientSnippet: Record<string, unknown> }).SentientSnippet;
    expect(typeof api.goal).toBe('function');
    expect(typeof api.componentGoal).toBe('function');
    expect(typeof api.reapply).toBe('function');
    const state = (api.getState as () => { persona: string; slots: unknown; matchCounts: Record<string, number> })();
    expect(state.persona).toBe('admin');
    expect(state.slots).toEqual({ hero: { tone: 'urgent' } });
    expect(state.matchCounts.hero).toBe(1);
  });

  it('reapply() re-stamps attributes after a hydration wipe without re-deciding', async () => {
    const decide = mockDecided();
    await run();
    document.getElementById('hero')!.removeAttribute('data-tone'); // simulate hydration wipe
    (window as unknown as { SentientSnippet: { reapply: () => void } }).SentientSnippet.reapply();
    expect(document.getElementById('hero')!.getAttribute('data-tone')).toBe('urgent');
    expect(decide).toHaveBeenCalledTimes(1);
  });
});

describe('run — bootstrap on a project with nothing published', () => {
  // Contract the API's empty-registry 200 depends on (apps/api decide route):
  // an empty DECISION must still start capture, while a FAILED decide must not.
  // If this pair ever inverts, a freshly-installed site silently stops feeding
  // the persona pipeline again.
  beforeEach(() => { (window as Window).sentient = { apiKey: 'pk_test' }; }); // registry install

  it('an empty decision still starts engagement capture', async () => {
    mockInit.mockReturnValue({
      decide: vi.fn().mockResolvedValue({
        layoutOrder: [], assignments: {}, slots: {}, persona: 'unknown', confidence: 0,
      }),
      getPersona: vi.fn().mockReturnValue(null),
      goal: vi.fn(), componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);

    await run();

    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it('a failed decide starts nothing (why the server must not 400 here)', async () => {
    mockInit.mockReturnValue({
      decide: vi.fn().mockResolvedValue(null), // what a 400 produces in core
      getPersona: vi.fn().mockReturnValue(null),
      goal: vi.fn(), componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);

    await run();

    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe('run — served section map types the engagement capture', () => {
  it('resolves sectionMap locators for the current page and passes typeOf to capture', async () => {
    (window as Window).sentient = { apiKey: 'pk_test' }; // registry install
    document.body.innerHTML = '<section id="about"><p>About our company values.</p></section>';
    mockInit.mockReturnValue({
      decide: vi.fn().mockResolvedValue({
        layoutOrder: null, assignments: {}, slots: {}, persona: 'unknown', confidence: 0,
        sectionMap: [
          // Current page (jsdom pathname '/') — resolvable by id.
          { urlMatch: '/', type: 'trust', locator: { v: 1, id: 'about', fingerprint: { tag: 'section' } } },
          // Different page — must be skipped.
          { urlMatch: '/pricing', type: 'pricing', locator: { v: 1, id: 'about' } },
        ],
      }),
      getPersona: vi.fn().mockReturnValue(null),
      goal: vi.fn(), componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);

    await run();

    expect(mockCapture).toHaveBeenCalledTimes(1);
    const opts = mockCapture.mock.calls[0]![1] as { typeOf?: (el: Element) => string | null };
    expect(typeof opts.typeOf).toBe('function');
    const about = document.getElementById('about')!;
    expect(opts.typeOf!(about)).toBe('trust');
    expect(opts.typeOf!(document.body)).toBeNull();
  });

  it('passes no typeOf when the outcome has no sectionMap', async () => {
    (window as Window).sentient = { apiKey: 'pk_test' };
    mockInit.mockReturnValue({
      decide: vi.fn().mockResolvedValue({ layoutOrder: null, assignments: {}, slots: {}, persona: 'unknown', confidence: 0 }),
      getPersona: vi.fn().mockReturnValue(null),
      goal: vi.fn(), componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);

    await run();

    expect(mockCapture).toHaveBeenCalledTimes(1);
    const opts = mockCapture.mock.calls[0]![1] as { typeOf?: unknown };
    expect(opts.typeOf).toBeUndefined();
  });
});

describe('run — registry boot', () => {
  it('sends slotsFrom:registry for a bare {apiKey} install and applies slotConfig', async () => {
    (window as Window).sentient = { apiKey: 'pk_test' }; // no declared slots
    const decide = vi.fn().mockResolvedValue({
      layoutOrder: null, assignments: {},
      slots: { hero: 'urgent' },
      slotConfig: { hero: { kind: 'arms', target: '#hero', content: 'Act now' } },
      persona: 'admin', confidence: 0.8,
    });
    mockInit.mockReturnValue({
      decide,
      getPersona: vi.fn().mockReturnValue({ persona: 'admin', confidence: 0.8, band: 'high' }),
    } as never);

    await run();

    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ slotsFrom: 'registry' }));
    const hero = document.getElementById('hero')!;
    expect(hero.getAttribute('data-sentient-arm')).toBe('urgent');
    expect(hero.textContent).toBe('Act now');

    // Snapshot v2 carries slotConfig so the return visit pre-paints the copy.
    const snap = readSnapshot('pk_test');
    expect(snap!.slotConfig).toEqual({ hero: { kind: 'arms', target: '#hero', content: 'Act now' } });
  });

  it('does not send slotsFrom when slots are declared (classic mode)', async () => {
    (window as Window).sentient = CONFIG; // declares hero slot
    const decide = vi.fn().mockResolvedValue({
      layoutOrder: null, assignments: {}, slots: { hero: { tone: 'urgent' } }, persona: 'admin', confidence: 0.8,
    });
    mockInit.mockReturnValue({ decide, getPersona: vi.fn().mockReturnValue(null) } as never);

    await run();
    expect(decide.mock.calls[0]![0].slotsFrom).toBeUndefined();
  });
});

describe('run — registry decides only components on this page (phantom trials)', () => {
  // Every decided registry component is a close-out trial. Deciding components
  // whose element is not on the page diluted every component's learning, and
  // reporting their absence as a locator miss auto-suspended healthy ones.
  const EMPTY = { layoutOrder: null, assignments: {}, slots: {}, persona: 'unknown', confidence: 0 };
  const missCalls = () =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/v1/locator-miss'))
      .map(([, init]) => JSON.parse((init as { body: string }).body).slots as string[]);
  function registryClient(decide: ReturnType<typeof vi.fn>): void {
    mockInit.mockReturnValue({
      decide, getPersona: vi.fn().mockReturnValue(null),
      goal: vi.fn(), componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);
  }
  beforeEach(() => { (window as Window).sentient = { apiKey: 'pk_test' }; });

  it('sends only resolvable ids; <html> components always; an absent unscoped one is neither decided nor a miss', async () => {
    document.body.innerHTML = '<section id="hero">Hi</section>';
    publishedLocators = [
      { id: 'hero', kind: 'arms', locator: { v: 1, id: 'hero', fingerprint: { tag: 'section' } } },
      { id: 'site-tone', kind: 'tokens', locator: null },
      { id: 'plans', kind: 'arms', locator: { v: 1, id: 'plans' } }, // lives on another page, unscoped
    ];
    const decide = vi.fn().mockResolvedValue(EMPTY);
    registryClient(decide);

    await run();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.sentient-ui.com/v1/registry/locators',
      expect.objectContaining({ headers: { authorization: 'Bearer pk_test' } }),
    );
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![0]).toMatchObject({ slotsFrom: 'registry', registrySlotIds: ['hero', 'site-tone'] });
    expect(decide.mock.calls[0]![0].bootstrap).toBeUndefined(); // goals + section map still needed
    expect(missCalls()).toEqual([]);
  });

  it('classifies misses when the watch window ends: scoped here and absent, or present but rejected; never scoped elsewhere', async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = '<section id="hero">Hi</section>';
      publishedLocators = [
        { id: 'faq', kind: 'arms', locator: { v: 1, id: 'faq', page: '/' } }, // expected here, absent
        { id: 'cta', kind: 'arms', locator: { v: 1, id: 'hero', fingerprint: { tag: 'button' } } }, // there, wrong element
        { id: 'plans', kind: 'arms', locator: { v: 1, id: 'plans', page: '/pricing' } }, // expected elsewhere
        { id: 'promo', kind: 'arms', locator: { v: 1, id: 'hero', urlMatch: '/pricing' } }, // URL-scoped out
      ];
      const decide = vi.fn().mockResolvedValue(EMPTY);
      registryClient(decide);

      await run();
      expect(decide.mock.calls[0]![0].registrySlotIds).toEqual([]);

      // A hydrating page may still render them: no page-scoped miss yet.
      await vi.advanceTimersByTimeAsync(2900);
      expect(missCalls()).toEqual([]);

      await vi.advanceTimersByTimeAsync(100);
      expect(missCalls()).toEqual([['faq', 'cta']]);
      expect(decide).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed locators request decides nothing and applies nothing — never an unscoped decide', async () => {
    publishedLocators = null;
    // Even a response that ignores registrySlotIds must not apply what was not asked for.
    const decide = vi.fn().mockResolvedValue({
      ...EMPTY,
      slots: { hero: 'urgent' },
      slotConfig: { hero: { kind: 'arms', target: '#hero', content: 'Act now' } },
      goals: [{ goalId: 'demo', event: 'click', locator: { id: 'hero' } }],
    });
    registryClient(decide);

    await run();

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![0]).toMatchObject({ slotsFrom: 'registry', registrySlotIds: [] });
    const hero = document.getElementById('hero')!;
    expect(hero.getAttribute('data-sentient-arm')).toBeNull();
    expect(hero.textContent).toBe('');
    expect(readSnapshot('pk_test')!.slotConfig).toBeUndefined();
    // Bootstrap still happened: capture started.
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  describe('late render (hydration / client routing)', () => {
    const LOCATORS = () => [
      { id: 'hero', kind: 'arms', locator: { v: 1, id: 'hero' } },
      { id: 'plans', kind: 'arms', locator: { v: 1, id: 'plans' } },
      { id: 'faq', kind: 'arms', locator: { v: 1, id: 'faq', page: '/pricing' } },
    ];
    const CONFIGS: Record<string, unknown> = {
      hero: { kind: 'arms', locator: { v: 1, id: 'hero' }, content: 'Hero copy' },
      plans: { kind: 'arms', locator: { v: 1, id: 'plans' }, content: 'Plans copy' },
    };
    function echoDecide() {
      const decide = vi.fn(async (input: { registrySlotIds: string[] }) => ({
        ...EMPTY,
        slots: Object.fromEntries(input.registrySlotIds.map((id) => [id, 'b'])),
        slotConfig: Object.fromEntries(input.registrySlotIds.map((id) => [id, CONFIGS[id]])),
      }));
      registryClient(decide);
      return decide;
    }
    function addPlans(): void {
      const el = document.createElement('div');
      el.id = 'plans';
      el.textContent = 'Old';
      document.body.appendChild(el);
    }

    beforeEach(() => {
      vi.useFakeTimers();
      document.body.innerHTML = '<section id="hero">Hi</section>';
      publishedLocators = LOCATORS();
    });
    afterEach(async () => {
      window.history.pushState({}, '', '/');
      await vi.advanceTimersByTimeAsync(WINDOW_END); // settle debounces and watch windows
      vi.useRealTimers();
    });
    const WINDOW_END = 3000;

    it('a component rendered after DOMContentLoaded, within the window, is decided and applied', async () => {
      const decide = echoDecide();
      await run();
      expect(decide.mock.calls[0]![0].registrySlotIds).toEqual(['hero']);

      await vi.advanceTimersByTimeAsync(1000);
      addPlans();
      await vi.advanceTimersByTimeAsync(100); // observer debounce

      expect(decide).toHaveBeenCalledTimes(2);
      expect(decide.mock.calls[1]![0]).toMatchObject({ slotsFrom: 'registry', registrySlotIds: ['plans'] });
      expect(document.getElementById('plans')!.textContent).toBe('Plans copy');
      expect(document.getElementById('hero')!.textContent).toBe('Hero copy');
      expect(Object.keys(readSnapshot('pk_test')!.slotConfig!)).toEqual(['hero', 'plans']);
    });

    it('a component rendered after the window ends is not decided', async () => {
      const decide = echoDecide();
      await run();
      await vi.advanceTimersByTimeAsync(WINDOW_END + 100);
      addPlans();
      await vi.advanceTimersByTimeAsync(500);

      expect(decide).toHaveBeenCalledTimes(1);
      expect(document.getElementById('plans')!.textContent).toBe('Old');
    });

    it('SPA navigation decides newly-resolving components once, merged, persisted; misses wait for the window', async () => {
      const decide = echoDecide();
      await run();
      expect(document.getElementById('hero')!.textContent).toBe('Hero copy');

      document.body.innerHTML = '<section id="hero">Hi</section><div id="plans">Old</div>';
      window.history.pushState({}, '', '/pricing');
      await vi.advanceTimersByTimeAsync(150);

      expect(decide).toHaveBeenCalledTimes(2);
      expect(decide.mock.calls[1]![0]).toMatchObject({ slotsFrom: 'registry', registrySlotIds: ['plans'] });
      expect(document.getElementById('plans')!.textContent).toBe('Plans copy');
      expect(document.getElementById('hero')!.getAttribute('data-sentient-arm')).toBe('b');
      const snap = readSnapshot('pk_test')!;
      expect(snap.slots).toEqual({ hero: 'b', plans: 'b' });
      expect(Object.keys(snap.slotConfig!)).toEqual(['hero', 'plans']);
      // faq is expected on /pricing but may still render: reported only at window end.
      expect(missCalls()).toEqual([]);
      await vi.advanceTimersByTimeAsync(WINDOW_END);
      expect(missCalls()).toEqual([['faq']]);

      // Back to a path where everything that resolves is already decided.
      window.history.pushState({}, '', '/');
      await vi.advanceTimersByTimeAsync(WINDOW_END + 100);
      expect(decide).toHaveBeenCalledTimes(2);
    });

    it('a decided, page-scoped component gets the whole window to re-render after navigation before it is a miss', async () => {
      // /pricing's component was decided during an earlier visit to /pricing;
      // navigating back runs the first check before the router has rendered.
      // "Decided" is not "pending", so the window used to end on that first
      // check and beacon a miss for a component that rendered 200ms later.
      publishedLocators = [
        { id: 'hero', kind: 'arms', locator: { v: 1, id: 'hero' } },
        { id: 'plans', kind: 'arms', locator: { v: 1, id: 'plans', page: '/pricing' } },
      ];
      const decide = echoDecide();
      await run();

      document.body.innerHTML = '<section id="hero">Hi</section><div id="plans">Old</div>';
      window.history.pushState({}, '', '/pricing');
      await vi.advanceTimersByTimeAsync(150);
      expect(decide.mock.calls[1]![0].registrySlotIds).toEqual(['plans']);

      // Away, then back — the router renders /pricing's content a beat later.
      document.body.innerHTML = '<section id="hero">Hi</section>';
      window.history.pushState({}, '', '/about');
      await vi.advanceTimersByTimeAsync(WINDOW_END + 100);
      window.history.pushState({}, '', '/pricing');
      await vi.advanceTimersByTimeAsync(100);
      expect(missCalls()).toEqual([]);
      document.body.innerHTML = '<section id="hero">Hi</section><div id="plans">Old</div>';
      await vi.advanceTimersByTimeAsync(WINDOW_END + 100);

      expect(missCalls()).toEqual([]);
      expect(decide).toHaveBeenCalledTimes(2); // sticky — no re-decide
      expect(document.getElementById('plans')!.textContent).toBe('Plans copy');
    });

    it('a legacy bare-selector component matching several elements is decided (apply writes them all)', async () => {
      // The server synthesizes { selector } for a Phase-2 string target; apply()
      // stamps every match for that target, so requiring exactly one match at
      // scan time silently stopped serving it after the page-scope upgrade.
      document.body.innerHTML = '<a class="cta">A</a><a class="cta">B</a>';
      publishedLocators = [{ id: 'ctas', kind: 'arms', locator: { selector: '.cta' } }];
      const decide = vi.fn(async (_input: { registrySlotIds: string[] }) => ({
        ...EMPTY,
        slots: { ctas: 'bold' },
        slotConfig: { ctas: { kind: 'arms', target: '.cta', content: 'Go' } },
      }));
      registryClient(decide);
      await run();

      expect(decide.mock.calls[0]![0].registrySlotIds).toEqual(['ctas']);
      const els = Array.from(document.querySelectorAll('.cta'));
      expect(els.map((e) => e.getAttribute('data-sentient-arm'))).toEqual(['bold', 'bold']);
      await vi.advanceTimersByTimeAsync(WINDOW_END + 100);
      expect(missCalls()).toEqual([]);
    });

    it('navigation disconnects the previous page’s observer', async () => {
      const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
      try {
        echoDecide();
        await run(); // plans + faq unresolved → watching
        expect(disconnect).not.toHaveBeenCalled();

        window.history.pushState({}, '', '/about');
        await vi.advanceTimersByTimeAsync(60); // reapply debounce, well inside the window
        expect(disconnect).toHaveBeenCalledTimes(1);
      } finally {
        disconnect.mockRestore();
      }
    });
  });

  it('declared-slot mode never fetches locators', async () => {
    (window as Window).sentient = CONFIG;
    const decide = vi.fn().mockResolvedValue(EMPTY);
    registryClient(decide);

    await run();

    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/v1/registry/locators'), expect.anything());
    expect(decide.mock.calls[0]![0].registrySlotIds).toBeUndefined();
  });
});

describe('parseEditorToken', () => {
  it('reads the editor token from the URL', () => {
    expect(parseEditorToken('?sentient_editor=tok123')).toBe('tok123');
    expect(parseEditorToken('?foo=bar')).toBeNull();
  });
});

describe('run — editor mode', () => {
  it('suppresses tracking and strips the token from the URL', async () => {
    window.history.pushState({}, '', '/?sentient_editor=tok123&keep=1');
    try {
      (window as Window).sentient = { apiKey: 'pk_test' };
      const decide = vi.fn();
      mockInit.mockReturnValue({ decide, getPersona: vi.fn() } as never);
      await run();
      expect(mockInit).not.toHaveBeenCalled();
      expect(decide).not.toHaveBeenCalled();
      // The bearer token must not linger in the URL (Phase 3 §1.4)…
      expect(window.location.search).not.toContain('sentient_editor');
      // …but unrelated params are preserved.
      expect(window.location.search).toContain('keep=1');
    } finally {
      window.history.pushState({}, '', '/'); // reset URL for other tests
    }
  });

  it('caches the token in sessionStorage so a reload re-enters editor mode without the dashboard', async () => {
    window.history.pushState({}, '', '/?sentient_editor=tok123');
    try {
      (window as Window).sentient = { apiKey: 'pk_test' };
      mockInit.mockReturnValue({ decide: vi.fn(), getPersona: vi.fn() } as never);

      // First load: token arrives in the URL → cached + stripped.
      await run();
      expect(sessionStorage.getItem('__snt_editor_token')).toBe('tok123');
      expect(window.location.search).not.toContain('sentient_editor');

      // Simulate a reload of the same tab: no URL token, but the cache still holds
      // it, so editor mode re-enters (loadEditor hands the token to the overlay)
      // and normal tracking never starts.
      delete (window as unknown as { __sentientEditor?: unknown }).__sentientEditor;
      await run();
      expect(mockInit).not.toHaveBeenCalled();
      expect(
        (window as unknown as { __sentientEditor?: { token?: string } }).__sentientEditor?.token,
      ).toBe('tok123');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('surfaces a load notice (never a blank page) when the editor bundle source cannot be resolved', async () => {
    window.history.pushState({}, '', '/?sentient_editor=tok123');
    try {
      (window as Window).sentient = { apiKey: 'pk_test' };
      mockInit.mockReturnValue({ decide: vi.fn(), getPersona: vi.fn() } as never);
      // jsdom has no <script src=…snippet.js> and no editorSrc is configured, so
      // deriveEditorSrc() returns null — the worst case that previously left a
      // silent blank page.
      await run();
      const notice = document.getElementById('sentient-editor-load-notice');
      expect(notice).not.toBeNull();
      expect(notice!.textContent).toContain('reopen it from your dashboard');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('parsePersonaPreview', () => {
  it('reads the persona key from the URL', () => {
    expect(parsePersonaPreview('?sentient_persona=admin')).toBe('admin');
    expect(parsePersonaPreview('?foo=bar')).toBeNull();
  });
});

describe('run — forced preview (?sentient_preview=) on registry slots', () => {
  // Registry (no-code) slot definitions live server-side. Preview mode returns
  // before the snapshot/decide paths that populate slotConfig, so without an
  // explain fetch applyRegistrySlots is skipped entirely and the whole mode is
  // a silent no-op for dashboard-defined slots — the exact case the dashboard
  // preview iframe depends on.
  it('fetches the published slot config and applies the FORCED arm, event-free', async () => {
    window.history.pushState({}, '', '/?sentient_preview=hero:urgent');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        // Explain resolves the FORCED arm's content (see `force` in the
        // request) — the server, not the client, owns arm→content.
        slots: { hero: 'urgent' },
        slotConfig: {
          hero: { kind: 'arms', target: '#hero', content: 'Urgent copy' },
        },
      }),
    });
    const origFetch = global.fetch;
    global.fetch = fetchMock as never;
    try {
      // Registry mode = no declared slots.
      (window as Window).sentient = { apiKey: 'pk_test', context: 'landing', slots: {} };
      mockInit.mockReturnValue({ decide: vi.fn(), getPersona: vi.fn() } as never);

      await run();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/v1/explain'),
        expect.objectContaining({ method: 'POST' }),
      );
      // The forced arm is sent so the server resolves THAT arm's content.
      const sent = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body));
      expect(sent.force).toEqual({ hero: 'urgent' });
      // Event-free, exactly like persona preview.
      expect(mockInit).not.toHaveBeenCalled();
      expect(readSnapshot('pk_test')).toBeNull();
      // The forced arm is on the page, not the server's suggestion.
      expect(document.getElementById('hero')!.textContent).toBe('Urgent copy');
    } finally {
      global.fetch = origFetch;
      window.history.pushState({}, '', '/');
    }
  });

  it('leaves the page alone when explain is unavailable rather than half-applying', async () => {
    window.history.pushState({}, '', '/?sentient_preview=hero:urgent');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    const origFetch = global.fetch;
    global.fetch = fetchMock as never;
    try {
      (window as Window).sentient = { apiKey: 'pk_test', context: 'landing', slots: {} };
      mockInit.mockReturnValue({ decide: vi.fn(), getPersona: vi.fn() } as never);
      document.getElementById('hero')!.textContent = 'Original copy';

      await run();

      expect(document.getElementById('hero')!.textContent).toBe('Original copy');
      // The page API must still exist (same rule as the other preview modes).
      expect((window as unknown as { SentientSnippet?: unknown }).SentientSnippet).toBeDefined();
    } finally {
      global.fetch = origFetch;
      window.history.pushState({}, '', '/');
    }
  });
});

describe('run — persona preview', () => {
  it('simulates a persona via /v1/explain, event-free (no init, no tracking, no snapshot)', async () => {
    window.history.pushState({}, '', '/?sentient_persona=admin');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        slots: { hero: { tone: 'urgent' } },
        persona: 'admin',
        personaAttributes: { persona: 'admin', confidence: 'high' },
      }),
    });
    const origFetch = global.fetch;
    global.fetch = fetchMock as never;
    try {
      (window as Window).sentient = CONFIG;
      mockInit.mockReturnValue({ decide: vi.fn(), getPersona: vi.fn() } as never);

      await run();

      // Read-only: never inits the tracking client and never writes a snapshot.
      expect(mockInit).not.toHaveBeenCalled();
      expect(readSnapshot('pk_test')).toBeNull();
      // Hits the read-only explain endpoint, not decide/track.
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/v1/explain'),
        expect.objectContaining({ method: 'POST' }),
      );
      // Simulated content is applied to the page.
      expect(document.getElementById('hero')!.getAttribute('data-tone')).toBe('urgent');
      expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('admin');
      // The "Exit preview" affordance is shown.
      expect(document.getElementById('sentient-persona-preview-banner')).not.toBeNull();
    } finally {
      global.fetch = origFetch;
      window.history.pushState({}, '', '/');
    }
  });

  it('registry-mode sites (no declared slots) ask the server for their published slots', async () => {
    window.history.pushState({}, '', '/?sentient_persona=evaluator');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ slots: {}, slotConfig: {}, persona: 'evaluator', personaAttributes: { persona: 'evaluator', confidence: 'high' } }),
    });
    const origFetch = global.fetch;
    global.fetch = fetchMock as never;
    try {
      (window as Window).sentient = { apiKey: 'pk_test' }; // no declared slots → registry mode
      mockInit.mockReturnValue({ decide: vi.fn(), getPersona: vi.fn() } as never);

      await run();

      expect(mockInit).not.toHaveBeenCalled();
      const sent = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
      expect(sent).toEqual({ persona: 'evaluator', slotsFrom: 'registry' });
    } finally {
      global.fetch = origFetch;
      window.history.pushState({}, '', '/');
    }
  });

  // Vocabulary echo (B1.2): the banner must never claim a persona the server
  // didn't actually simulate — /v1/explain now resolves against the project
  // vocabulary and echoes { personaDisplay, recognized }.
  it('says so (and shows the typed value) when the server flags the persona as unrecognized', async () => {
    window.history.pushState({}, '', '/?sentient_persona=staff');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        slots: {},
        persona: 'unknown',
        recognized: false,
        personaAttributes: { persona: 'unknown', confidence: 'low' },
      }),
    });
    const origFetch = global.fetch;
    global.fetch = fetchMock as never;
    try {
      (window as Window).sentient = CONFIG;
      mockInit.mockReturnValue({ decide: vi.fn(), getPersona: vi.fn() } as never);

      await run();

      const banner = document.getElementById('sentient-persona-preview-banner');
      expect(banner).not.toBeNull();
      // Quotes what was TYPED (the fix target: previously showed a cosmetic
      // "Staff" while simulating 'unknown'), and says the page is the default.
      expect(banner!.textContent).toContain('staff');
      expect(banner!.textContent).toContain('isn’t in your personas');
      expect(banner!.textContent).not.toContain('Previewing as');
      // The default experience the server simulated is still applied.
      expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('unknown');
    } finally {
      global.fetch = origFetch;
      window.history.pushState({}, '', '/');
    }
  });

  it('prefers the server display name for a recognized persona', async () => {
    window.history.pushState({}, '', '/?sentient_persona=admin');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        slots: {},
        persona: 'admin',
        personaDisplay: 'Admin Team',
        recognized: true,
        personaAttributes: { persona: 'admin', confidence: 'high' },
      }),
    });
    const origFetch = global.fetch;
    global.fetch = fetchMock as never;
    try {
      (window as Window).sentient = CONFIG;
      mockInit.mockReturnValue({ decide: vi.fn(), getPersona: vi.fn() } as never);

      await run();

      const banner = document.getElementById('sentient-persona-preview-banner');
      expect(banner!.textContent).toContain('Previewing as Admin Team');
    } finally {
      global.fetch = origFetch;
      window.history.pushState({}, '', '/');
    }
  });
});

describe('run — section reordering (B1.1)', () => {
  const SECTIONS = ['#s1', '#s2', '#s3'];

  function sectionsDom(): void {
    document.body.innerHTML =
      '<main><section id="s1"></section><section id="s2"></section><section id="s3"></section></main>';
  }
  function order(): string[] {
    return Array.from(document.querySelectorAll('section')).map((el) => el.id);
  }
  function client(layoutOrder: string[] | null) {
    return {
      decide: vi.fn().mockResolvedValue({
        layoutOrder, assignments: {}, slots: {}, persona: 'admin', confidence: 0.8,
      }),
      getPersona: vi.fn().mockReturnValue({ persona: 'admin', confidence: 0.8, band: 'high' }),
      goal: vi.fn(), componentGoal: vi.fn(), destroy: vi.fn(),
    };
  }

  it('sends the resolved sections on decide and applies the returned order', async () => {
    sectionsDom();
    (window as Window).sentient = { apiKey: 'pk_test', registry: false, sections: SECTIONS };
    const cl = client(['#s3', '#s1', '#s2']);
    mockInit.mockReturnValue(cl as never);

    await run();

    expect(cl.decide).toHaveBeenCalledWith(expect.objectContaining({ sections: SECTIONS }));
    expect(order()).toEqual(['s3', 's1', 's2']);
    // The order is persisted for the next visit's pre-paint (the field is live now).
    expect(readSnapshot('pk_test')!.layoutOrder).toEqual(['#s3', '#s1', '#s2']);
  });

  it('drops missing and ambiguous selectors; fewer than two left → no sections sent', async () => {
    document.body.innerHTML =
      '<main><section id="s1"></section><div class="dup"></div><div class="dup"></div></main>';
    (window as Window).sentient = {
      apiKey: 'pk_test', registry: false, sections: ['#s1', '.dup', '#missing'],
      slots: { hero: { dims: { tone: ['calm', 'urgent'] } } },
    };
    const cl = client(null);
    mockInit.mockReturnValue(cl as never);

    await run();

    expect((cl.decide.mock.calls[0]![0] as { sections?: string[] }).sections).toBeUndefined();
  });

  it('applies nothing when the returned order is not a permutation of the resolvable set', async () => {
    sectionsDom();
    (window as Window).sentient = { apiKey: 'pk_test', registry: false, sections: SECTIONS };
    const cl = client(['#s3', '#s1']); // one section short — drifted server state
    mockInit.mockReturnValue(cl as never);

    await run();

    expect(order()).toEqual(['s1', 's2', 's3']); // natural order stands
  });

  it('applies nothing when the sections do not share one parent', async () => {
    document.body.innerHTML =
      '<main><section id="s1"></section><section id="s2"></section></main>' +
      '<aside><section id="s3"></section></aside>';
    (window as Window).sentient = { apiKey: 'pk_test', registry: false, sections: SECTIONS };
    const cl = client(['#s3', '#s2', '#s1']);
    mockInit.mockReturnValue(cl as never);

    await run();

    expect(order()).toEqual(['s1', 's2', 's3']);
  });

  it('pre-paints the cached snapshot order even when decide never confirms it', async () => {
    sectionsDom();
    writeSnapshot('pk_test', {
      v: 1, persona: 'admin', band: 'high', slots: {},
      layoutOrder: ['#s2', '#s3', '#s1'], savedAt: Date.now(),
    } as never);
    (window as Window).sentient = { apiKey: 'pk_test', registry: false, sections: SECTIONS };
    mockInit.mockReturnValue({
      decide: vi.fn().mockRejectedValue(new Error('decide offline')),
      getPersona: vi.fn().mockReturnValue(null),
      goal: vi.fn(), componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);

    await run();

    expect(order()).toEqual(['s2', 's3', 's1']); // no natural-order flash on return visits
  });

  it('a cached order that no longer matches the page/config applies nothing', async () => {
    sectionsDom();
    writeSnapshot('pk_test', {
      v: 1, persona: 'admin', band: 'high', slots: {},
      layoutOrder: ['#s2', '#gone', '#s1'], savedAt: Date.now(),
    } as never);
    (window as Window).sentient = { apiKey: 'pk_test', registry: false, sections: SECTIONS };
    mockInit.mockReturnValue({
      decide: vi.fn().mockRejectedValue(new Error('decide offline')),
      getPersona: vi.fn().mockReturnValue(null),
      goal: vi.fn(), componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);

    await run();

    expect(order()).toEqual(['s1', 's2', 's3']);
  });

  it('reapply() restores the served order after a hydration wipe', async () => {
    sectionsDom();
    (window as Window).sentient = { apiKey: 'pk_test', registry: false, sections: SECTIONS };
    const cl = client(['#s2', '#s1', '#s3']);
    mockInit.mockReturnValue(cl as never);

    await run();
    expect(order()).toEqual(['s2', 's1', 's3']);

    sectionsDom(); // hydration rebuilds the DOM in natural order
    reapply();
    expect(order()).toEqual(['s2', 's1', 's3']);
  });
});

describe('parsePreview', () => {
  it('parses dims and enumerated arms', () => {
    expect(parsePreview('?sentient_preview=hero:tone=urgent,motion=pulse|cta:express')).toEqual({
      hero: { tone: 'urgent', motion: 'pulse' },
      cta: 'express',
    });
  });
  it('returns null when no preview param is present', () => {
    expect(parsePreview('?foo=bar')).toBeNull();
  });
  it('splits on the first colon only, so values may contain colons', () => {
    expect(parsePreview('?sentient_preview=hero:label=a:b')).toEqual({
      hero: { label: 'a:b' },
    });
  });
});

describe('run — registry slotConfig lifecycle (audit: cached config never cleared)', () => {
  it('clears a cached slotConfig when a registry decide returns none (no stale slot revived)', async () => {
    // Prior visit persisted a registry slot with copy. This visit the server no
    // longer publishes it (decide returns no slotConfig) — the cached config must
    // be dropped, not re-applied and re-persisted.
    writeSnapshot('pk_test', {
      v: 1, persona: 'admin', band: 'high',
      slots: { hero: 'urgent' }, layoutOrder: null, savedAt: Date.now(),
      slotConfig: { hero: { kind: 'arms', target: '#hero', content: 'Old copy' } },
    } as never);
    (window as Window).sentient = { apiKey: 'pk_test' }; // registry mode
    mockInit.mockReturnValue({
      decide: vi.fn().mockResolvedValue({
        layoutOrder: null, assignments: {}, slots: { hero: 'urgent' }, persona: 'admin', confidence: 0.8,
        // no slotConfig
      }),
      getPersona: vi.fn().mockReturnValue({ persona: 'admin', confidence: 0.8, band: 'high' }),
      goal: vi.fn(), componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);

    await run();

    // The cleared config must not be re-persisted…
    expect(readSnapshot('pk_test')!.slotConfig).toBeUndefined();
    // …nor its copy applied to the page.
    expect(document.getElementById('hero')!.textContent).not.toBe('Old copy');
  });
});

describe('run — reapply during the decide window (audit: stale-content flash)', () => {
  it('does not paint cached registry copy on a reapply before decide resolves', async () => {
    // Return visitor: snapshot carries registry copy. Pre-paint applies reversible
    // attributes only; if an SPA navigation triggers reapply() before decide
    // confirms, it must NOT restamp the (possibly stale) copy — a decide timeout
    // would otherwise leave it stuck for the whole visit.
    writeSnapshot('pk_test', {
      v: 1, persona: 'admin', band: 'high',
      slots: { hero: 'urgent' }, layoutOrder: null, savedAt: Date.now(),
      slotConfig: { hero: { kind: 'arms', target: '#hero', content: 'Stale copy' } },
    } as never);
    (window as Window).sentient = { apiKey: 'pk_test' }; // registry mode
    mockInit.mockReturnValue({
      decide: vi.fn().mockRejectedValue(new Error('decide offline')),
      getPersona: vi.fn().mockReturnValue(null),
      goal: vi.fn(), componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);

    await run(); // decide rejects → `decided` stays false

    reapply(); // SPA navigation / hydration wipe during the decide window
    const hero = document.getElementById('hero')!;
    expect(hero.textContent).not.toBe('Stale copy'); // copy withheld
    expect(hero.getAttribute('data-sentient-arm')).toBe('urgent'); // reversible attr still restamped
  });
});

describe('run — section capture across SPA navigation (audit: capture only covered page 1)', () => {
  it('restarts section capture against the new document when the path changes', async () => {
    (window as Window).sentient = { apiKey: 'pk_test' }; // registry mode
    mockInit.mockReturnValue({
      decide: vi.fn().mockResolvedValue({ layoutOrder: null, assignments: {}, slots: {}, persona: 'unknown', confidence: 0 }),
      getPersona: vi.fn().mockReturnValue(null),
      goal: vi.fn(), componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);
    const cleanup1 = vi.fn();
    const cleanup2 = vi.fn();
    mockCapture.mockReturnValueOnce(cleanup1).mockReturnValueOnce(cleanup2);

    await run();
    expect(mockCapture).toHaveBeenCalledTimes(1); // first page

    // Same-path reapply must NOT restart capture.
    reapply();
    expect(mockCapture).toHaveBeenCalledTimes(1);

    // SPA navigation to a new route → tear down page-1 capture, restart on page 2.
    window.history.pushState({}, '', '/about');
    try {
      reapply();
      expect(cleanup1).toHaveBeenCalledTimes(1);
      expect(mockCapture).toHaveBeenCalledTimes(2);
      // The restart runs against the current document/route.
      expect((mockCapture.mock.calls[1]![1] as { doc?: Document }).doc).toBe(document);
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('revokeConsent tears down the section capture observers/listeners', async () => {
    (window as Window).sentient = { apiKey: 'pk_test' }; // registry mode
    const destroy = vi.fn();
    mockInit.mockReturnValue({
      decide: vi.fn().mockResolvedValue({ layoutOrder: null, assignments: {}, slots: {}, persona: 'unknown', confidence: 0 }),
      getPersona: vi.fn().mockReturnValue(null),
      goal: vi.fn(), componentGoal: vi.fn(), destroy,
    } as never);
    const captureCleanup = vi.fn();
    mockCapture.mockReturnValueOnce(captureCleanup);

    await run();
    const api = (window as unknown as { SentientSnippet: { revokeConsent: () => void } }).SentientSnippet;
    api.revokeConsent();

    expect(captureCleanup).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('run — grantConsent starts capture for a consent-after-load visitor (audit)', () => {
  it('starts section capture on grantConsent() when the site booted with consent:false', async () => {
    mockCapture.mockReturnValue(vi.fn()); // real capture returns a cleanup fn
    (window as Window).sentient = { ...CONFIG, consent: false };
    mockInit.mockReturnValue({
      decide: vi.fn().mockResolvedValue({
        layoutOrder: null, assignments: {}, slots: { hero: { tone: 'urgent' } }, persona: 'admin', confidence: 0.8,
      }),
      getPersona: vi.fn().mockReturnValue({ persona: 'admin', confidence: 0.8, band: 'high' }),
      goal: vi.fn(), componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);

    await run();
    // Consent withheld at boot → the capture gate stayed shut in run().
    expect(mockCapture).not.toHaveBeenCalled();

    const api = (window as unknown as { SentientSnippet: { grantConsent: () => void } }).SentientSnippet;
    api.grantConsent();
    // Consent granted live now starts section engagement + per-option capture,
    // without waiting for a full page reload.
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockAttachSlot).toHaveBeenCalled();

    // Idempotent: a second grantConsent() must not double-start capture.
    api.grantConsent();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});

describe('run — revokeConsent tears down editor goal listeners (audit: leak on destroyed client)', () => {
  it('fires no goal after revoke, because the delegated listeners are removed', async () => {
    (window as Window).sentient = { apiKey: 'pk_test' }; // registry mode (consent on)
    document.body.innerHTML = '<a id="cta">Book</a>';
    const goal = vi.fn();
    mockInit.mockReturnValue({
      decide: vi.fn().mockResolvedValue({
        layoutOrder: null, assignments: {}, slots: {}, persona: 'unknown', confidence: 0,
        goals: [{ goalId: 'demo', event: 'click', locator: { id: 'cta' } }],
      }),
      getPersona: vi.fn().mockReturnValue(null),
      goal, componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);

    await run();
    const api = (window as unknown as { SentientSnippet: { revokeConsent: () => void } }).SentientSnippet;
    api.revokeConsent();

    document.getElementById('cta')!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(goal).not.toHaveBeenCalled();
  });
});

describe('run — reapply always detaches prior-page slot detectors (audit: SPA leak)', () => {
  it('tears down slot-signal detectors even when the new route applies no slots', async () => {
    mockAttachSlot.mockImplementation(() => vi.fn()); // fresh cleanup spy per call
    (window as Window).sentient = { apiKey: 'pk_test' }; // registry mode
    mockInit.mockReturnValue({
      decide: vi.fn().mockResolvedValue({
        layoutOrder: null, assignments: {},
        slots: { hero: 'urgent' },
        slotConfig: { hero: { kind: 'arms', target: '#hero', content: 'Act now' } },
        persona: 'admin', confidence: 0.8,
      }),
      getPersona: vi.fn().mockReturnValue({ persona: 'admin', confidence: 0.8, band: 'high' }),
      goal: vi.fn(), componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);

    await run();
    // Page 1 resolved #hero → detectors attached once.
    expect(mockAttachSlot).toHaveBeenCalledTimes(1);
    const cleanup1 = mockAttachSlot.mock.results[0]!.value as ReturnType<typeof vi.fn>;

    // Navigate to a route where the slot no longer resolves (0 applied slots).
    document.getElementById('hero')!.remove();
    window.history.pushState({}, '', '/empty');
    try {
      reapply();
      // Prior-page detectors were torn down despite the new page applying no slots.
      expect(cleanup1).toHaveBeenCalledTimes(1);
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('run — snapshot round-trip (pre-paint on return visit)', () => {
  it('applies a previously written snapshot even when decide fails', async () => {
    writeSnapshot('pk_test', {
      v: 1, persona: 'trial_user', band: 'medium',
      slots: { hero: { tone: 'calm' } }, layoutOrder: null, savedAt: Date.now(),
    });
    mockInit.mockReturnValue({
      decide: vi.fn().mockRejectedValue(new Error('offline')),
      getPersona: vi.fn().mockReturnValue(null),
    } as never);

    await run();

    // Pre-paint application from the snapshot survives the failed decide.
    expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('trial_user');
    expect(document.documentElement.getAttribute('data-sentient-confidence')).toBe('medium');
    expect(document.getElementById('hero')!.getAttribute('data-tone')).toBe('calm');
  });
});

describe('run — revokeConsent then grantConsent resumes tracking', () => {
  // revokeConsent() destroys the core client, which deletes its registry
  // entry; the snippet then kept pointing capture and the page API at the dead
  // client, so grantConsent() warned "called before init()" and recorded zero
  // events with no visible error until a full reload. Grant after revoke must
  // re-init a FRESH consented client (revoke deliberately forgot the visitor,
  // so a new identity is minted — that severing is the point of revocation).
  it('re-inits a fresh consented client and goals record again', async () => {
    (window as Window).sentient = { apiKey: 'pk_test' }; // registry mode
    document.body.innerHTML = '<a id="cta">Book</a>';
    const firstGoal = vi.fn();
    const destroy = vi.fn();
    mockInit.mockReturnValueOnce({
      decide: vi.fn().mockResolvedValue({
        layoutOrder: null, assignments: {}, slots: {}, persona: 'unknown', confidence: 0,
        goals: [{ goalId: 'demo', event: 'click', locator: { id: 'cta' } }],
      }),
      getPersona: vi.fn().mockReturnValue(null),
      goal: firstGoal, componentGoal: vi.fn(), destroy,
    } as never);
    const secondGoal = vi.fn();
    mockInit.mockReturnValueOnce({
      decide: vi.fn(), getPersona: vi.fn().mockReturnValue(null),
      goal: secondGoal, componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);

    await run();
    const api = (window as unknown as {
      SentientSnippet: { revokeConsent(): void; grantConsent(): void; goal(n: string): void };
    }).SentientSnippet;

    api.revokeConsent();
    expect(destroy).toHaveBeenCalledTimes(1);

    api.grantConsent();
    // A fresh init with consent granted — not an upgrade of the dead client.
    expect(mockInit).toHaveBeenCalledTimes(2);
    expect(mockInit.mock.calls[1]![0]).toMatchObject({ apiKey: 'pk_test', consent: true });

    // The page API records through the NEW client…
    api.goal('purchase');
    expect(secondGoal).toHaveBeenCalledWith('purchase', undefined);
    expect(firstGoal).not.toHaveBeenCalled();

    // …and the editor-defined goal listeners are re-wired to it too (they were
    // torn down by revoke; the served decision is re-used, never re-decided).
    document.getElementById('cta')!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(secondGoal).toHaveBeenCalledWith('demo');
  });

  it('grantConsent never mints a tracking client when none was ever created', async () => {
    // Preview mode exposes the API with no client. grant there must stay a
    // no-op (those modes promise zero tracking), not re-init.
    window.history.pushState({}, '', '/?sentient_preview=hero:tone=urgent');
    try {
      await run();
      const api = (window as unknown as { SentientSnippet: { grantConsent(): void } }).SentientSnippet;
      api.grantConsent();
      expect(mockInit).not.toHaveBeenCalled();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('run — editor/preview modes still expose the page API (stranded global)', () => {
  // Those paths returned before exposeGlobal(), leaving the build-time module
  // exports as the global: merchant code calling SentientSnippet.goal(...)
  // threw, and the pre-boot stub queue was never drained. The modes suppress
  // tracking, so the exposed API is a no-op surface — but it must EXIST.
  it('editor mode exposes a callable no-op SentientSnippet', async () => {
    window.history.pushState({}, '', '/?sentient_editor=tok123');
    try {
      (window as Window).sentient = { apiKey: 'pk_test' };
      await run();
      expect(mockInit).not.toHaveBeenCalled();
      const api = (window as unknown as {
        SentientSnippet: { goal(n: string, o?: unknown): void; getState(): { apiKey: string } };
      }).SentientSnippet;
      expect(typeof api.goal).toBe('function');
      expect(() => api.goal('purchase', { value: 10 })).not.toThrow();
      expect(api.getState().apiKey).toBe('pk_test');
    } finally {
      sessionStorage.clear(); // drop the cached editor token for later tests
      window.history.pushState({}, '', '/');
    }
  });

  it('preview mode exposes a callable no-op SentientSnippet', async () => {
    window.history.pushState({}, '', '/?sentient_preview=hero:tone=urgent');
    try {
      await run();
      expect(mockInit).not.toHaveBeenCalled();
      const api = (window as unknown as {
        SentientSnippet: { goal(n: string): void };
      }).SentientSnippet;
      expect(typeof api.goal).toBe('function');
      expect(() => api.goal('purchase')).not.toThrow();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('run — late decide after the timeout (audit SNIP-18: timeout meant total loss of the view)', () => {
  function pendingDecide() {
    let resolveDecide!: (v: unknown) => void;
    const goal = vi.fn();
    mockInit.mockReturnValue({
      decide: vi.fn(() => new Promise((res) => { resolveDecide = res; })),
      getPersona: vi.fn().mockReturnValue({ persona: 'admin', confidence: 0.8, band: 'high' }),
      goal, componentGoal: vi.fn(), destroy: vi.fn(),
    } as never);
    return { resolve: (v: unknown) => resolveDecide(v), goal };
  }

  const LATE_OUTCOME = {
    layoutOrder: null, assignments: {},
    slots: { hero: 'urgent' },
    slotConfig: { hero: { kind: 'arms', target: '#hero', content: 'Act now' } },
    persona: 'admin', confidence: 0.8,
    goals: [{ goalId: 'demo', event: 'click', locator: { id: 'cta' } }],
  };

  it('applies content, wires goals and writes the snapshot when decide resolves at 6-8s', async () => {
    vi.useFakeTimers();
    try {
      (window as Window).sentient = { apiKey: 'pk_test' }; // registry mode
      document.body.innerHTML = '<section id="hero"></section><a id="cta">Book</a>';
      const { resolve, goal } = pendingDecide();

      const running = run();
      await vi.advanceTimersByTimeAsync(5000); // decide loses the withTimeout race
      await running;

      // The timed-out view applied nothing yet and persisted nothing.
      expect(document.getElementById('hero')!.textContent).toBe('');
      expect(readSnapshot('pk_test')).toBeNull();

      resolve(LATE_OUTCOME); // the roundtrip completes at ~6s
      await vi.advanceTimersByTimeAsync(0); // flush the late-arrival chain

      // Content applied late — late personalization beats total loss.
      expect(document.getElementById('hero')!.textContent).toBe('Act now');
      expect(document.getElementById('hero')!.getAttribute('data-sentient-arm')).toBe('urgent');
      // Goals wired.
      document.getElementById('cta')!.dispatchEvent(new Event('click', { bubbles: true }));
      expect(goal).toHaveBeenCalledWith('demo');
      // Snapshot written — the late decision becomes the next view's state
      // (the "snapshot state stands" contract, working as intended).
      const snap = readSnapshot('pk_test');
      expect(snap).not.toBeNull();
      expect(snap!.slots).toEqual({ hero: 'urgent' });
      expect(snap!.persona).toBe('admin');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies nothing when consent was revoked while the late decide was in flight', async () => {
    vi.useFakeTimers();
    try {
      (window as Window).sentient = { apiKey: 'pk_test' }; // registry mode
      document.body.innerHTML = '<section id="hero"></section><a id="cta">Book</a>';
      const { resolve, goal } = pendingDecide();

      const running = run();
      await vi.advanceTimersByTimeAsync(5000);
      await running;

      // Visitor revokes during the late window — forget-me must win.
      const api = (window as unknown as { SentientSnippet: { revokeConsent: () => void } }).SentientSnippet;
      api.revokeConsent();

      resolve(LATE_OUTCOME);
      await vi.advanceTimersByTimeAsync(0);

      // No content, no goal wiring, no snapshot.
      expect(document.getElementById('hero')!.textContent).toBe('');
      expect(document.getElementById('hero')!.getAttribute('data-sentient-arm')).toBeNull();
      document.getElementById('cta')!.dispatchEvent(new Event('click', { bubbles: true }));
      expect(goal).not.toHaveBeenCalled();
      expect(readSnapshot('pk_test')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('run — inline pre-paint hand-off (spec 2026-09-07 §3.4)', () => {
  /** Seed a window.__sntPP as the inline script would have left it. */
  function seedPrePaint(over: Partial<Record<string, unknown>> = {}): {
    stop: ReturnType<typeof vi.fn>;
    record: Record<string, unknown>;
  } {
    const stop = vi.fn();
    const record = {
      v: 1, at: Date.now(), stamped: [], html: [], reordered: false, done: false, stop,
      ...over,
    };
    (window as unknown as { __sntPP?: unknown }).__sntPP = record;
    return { stop, record };
  }

  function offlineClient(): void {
    mockInit.mockReturnValue({
      decide: vi.fn().mockRejectedValue(new Error('offline')),
      getPersona: vi.fn().mockReturnValue(null),
    } as never);
  }

  beforeEach(() => {
    delete (window as unknown as { __sntPP?: unknown }).__sntPP;
  });

  it('stops the inline observer before doing anything else', async () => {
    const { stop } = seedPrePaint();
    offlineClient();
    await run();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('leaves a stamp alone when its own pass re-applies the same attribute', async () => {
    const hero = document.getElementById('hero')!;
    hero.setAttribute('data-tone', 'urgent');
    seedPrePaint({ stamped: [[hero, 'data-tone', null]] });
    writeSnapshot('pk_test', {
      v: 1, persona: 'trial_user', band: 'medium',
      slots: { hero: { tone: 'urgent' } }, layoutOrder: null, savedAt: Date.now(),
    });
    offlineClient();

    await run();

    expect(hero.getAttribute('data-tone')).toBe('urgent');
  });

  it('reverts a stamp this bundle does NOT confirm (the fingerprint the inline could not check)', async () => {
    // The inline stamped a DIFFERENT element than the one our config targets —
    // exactly what a mid-parse selector or an unverified fingerprint can produce.
    const stranger = document.createElement('div');
    stranger.id = 'stranger';
    stranger.setAttribute('data-tone', 'urgent');
    document.body.appendChild(stranger);
    seedPrePaint({ stamped: [[stranger, 'data-tone', null]] });
    writeSnapshot('pk_test', {
      v: 1, persona: 'trial_user', band: 'medium',
      slots: { hero: { tone: 'urgent' } }, layoutOrder: null, savedAt: Date.now(),
    });
    offlineClient();

    await run();

    expect(stranger.hasAttribute('data-tone')).toBe(false);
    // ...and the element we DO own is still stamped.
    expect(document.getElementById('hero')!.getAttribute('data-tone')).toBe('urgent');
  });

  it('restores the merchant’s prior value rather than removing the attribute', async () => {
    const stranger = document.createElement('div');
    stranger.setAttribute('data-tone', 'urgent');
    document.body.appendChild(stranger);
    seedPrePaint({ stamped: [[stranger, 'data-tone', 'calm']] });
    offlineClient();

    await run();

    expect(stranger.getAttribute('data-tone')).toBe('calm');
  });

  it('removes <html> persona attributes when this bundle’s gate says they are off', async () => {
    // personaAttributes is not `true` here, so our pass writes nothing on <html>
    // — the inline script's looser truthiness check must not outlive it.
    (window as Window).sentient = { ...CONFIG, personaAttributes: 1 };
    document.documentElement.setAttribute('data-sentient-persona', 'trial_user');
    document.documentElement.setAttribute('data-sentient-confidence', 'medium');
    seedPrePaint({ html: ['data-sentient-persona', 'data-sentient-confidence'] });
    writeSnapshot('pk_test', {
      v: 1, persona: 'trial_user', band: 'medium',
      slots: {}, layoutOrder: null, savedAt: Date.now(),
    });
    offlineClient();

    await run();

    expect(document.documentElement.hasAttribute('data-sentient-persona')).toBe(false);
    expect(document.documentElement.hasAttribute('data-sentient-confidence')).toBe(false);
  });

  it('reverts everything when there is no snapshot left to confirm against', async () => {
    const hero = document.getElementById('hero')!;
    hero.setAttribute('data-tone', 'urgent');
    seedPrePaint({ stamped: [[hero, 'data-tone', null]] });
    offlineClient();

    await run();

    expect(hero.hasAttribute('data-tone')).toBe(false);
  });

  it('ignores a malformed record without breaking the visit', async () => {
    (window as unknown as { __sntPP?: unknown }).__sntPP = { v: 1, stamped: 'not an array', html: 7 };
    writeSnapshot('pk_test', {
      v: 1, persona: 'trial_user', band: 'medium',
      slots: { hero: { tone: 'calm' } }, layoutOrder: null, savedAt: Date.now(),
    });
    offlineClient();

    await expect(run()).resolves.toBeUndefined();
    expect(document.getElementById('hero')!.getAttribute('data-tone')).toBe('calm');
  });

  it('tolerates a record with no stop() (a future contract that dropped it)', async () => {
    (window as unknown as { __sntPP?: unknown }).__sntPP = { v: 2, stamped: [], html: [] };
    offlineClient();
    await expect(run()).resolves.toBeUndefined();
  });

  it('reports the inline contract version on decide, and 0 for a two-tag install', async () => {
    const decide = vi.fn().mockResolvedValue({
      layoutOrder: null, assignments: {}, slots: {}, persona: 'admin', confidence: 0.8,
    });
    mockInit.mockReturnValue({ decide, getPersona: vi.fn().mockReturnValue(null) } as never);

    await run();
    expect(decide.mock.calls[0]![0]).toMatchObject({ pp: 0 });

    decide.mockClear();
    seedPrePaint();
    await run();
    expect(decide.mock.calls[0]![0]).toMatchObject({ pp: 1 });
  });
});
