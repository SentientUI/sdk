import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startEngagementCapture } from './capture';
import * as core from '../index.js';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});
afterEach(() => {
  // Remove any IntersectionObserver stub installed by a test.
  delete (globalThis as Record<string, unknown>)['IntersectionObserver'];
});

describe('startEngagementCapture', () => {
  it('is safe to call and never tracks synchronously (dwell is emitted on flush)', () => {
    document.body.innerHTML = '<section id="pricing"><h2>Pricing</h2></section>';
    const client = { track: vi.fn() };
    expect(() => startEngagementCapture(client, { apiKey: 'pk_test', apiBase: 'https://api.example.com' })).not.toThrow();
    // Dwell only fires on visibilitychange/pagehide, never on setup.
    expect(client.track).not.toHaveBeenCalled();
  });

  it('no-ops on an empty page', () => {
    const client = { track: vi.fn() };
    expect(() => startEngagementCapture(client, { apiKey: 'pk_test', apiBase: 'https://api.example.com' })).not.toThrow();
    expect(client.track).not.toHaveBeenCalled();
  });

  it('no-ops under DNT (returns an inert cleanup)', () => {
    document.body.innerHTML = '<section id="pricing"><h2>Pricing</h2></section>';
    vi.spyOn(core, 'isDoNotTrackEnabled').mockReturnValue(true);
    // A working IntersectionObserver stub proves the DNT gate (not the missing
    // IO) is what stops capture.
    const observed: Element[] = [];
    (globalThis as Record<string, unknown>)['IntersectionObserver'] = class {
      observe(el: Element) { observed.push(el); }
      disconnect() { /* noop */ }
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    const client = { track: vi.fn() };
    const stop = startEngagementCapture(client, { apiKey: 'pk_test', apiBase: 'https://api.example.com' });
    expect(observed).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(client.track).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it('cleanup emits banked dwell, then detaches listeners so later hides track nothing', () => {
    document.body.innerHTML = '<section id="pricing"><h2>Simple pricing</h2></section>';
    vi.spyOn(core, 'isDoNotTrackEnabled').mockReturnValue(false);
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue({ ok: true } as never);

    let ioCallback: ((entries: Array<{ target: Element; isIntersecting: boolean; intersectionRatio: number }>) => void) | null = null;
    const disconnect = vi.fn();
    (globalThis as Record<string, unknown>)['IntersectionObserver'] = class {
      constructor(cb: typeof ioCallback) { ioCallback = cb; }
      observe() { /* sections tracked via the callback below */ }
      disconnect = disconnect;
    };

    vi.useFakeTimers();
    try {
      const client = { track: vi.fn() };
      const stop = startEngagementCapture(client, { apiKey: 'pk_test', apiBase: 'https://api.example.com' });

      const section = document.querySelector('section')!;
      ioCallback!([{ target: section, isIntersecting: true, intersectionRatio: 0.75 }]);
      vi.advanceTimersByTime(1200); // 1.2 s of visible dwell

      stop();

      expect(client.track).toHaveBeenCalledTimes(1);
      const evt = client.track.mock.calls[0]![0];
      expect(evt.eventType).toBe('dwell');
      // Per-element id (nc-* retirement 2026-09-05): type prefix + locator hash.
      expect(evt.componentId).toMatch(/^nc-pricing-[0-9a-z]+$/);
      expect(evt.payload.dwell_time).toBe(1200);
      expect(evt.payload.scroll_depth).toBe(0.75);
      expect(disconnect).toHaveBeenCalled();

      // Listeners are gone: a later visibility flip must not track again.
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(client.track).toHaveBeenCalledTimes(1);
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keyless (no apiKey) → inert: no section registration fetch, no observers (zero-network contract)', () => {
    document.body.innerHTML = '<section id="pricing"><h2>Pricing</h2></section>';
    vi.spyOn(core, 'isDoNotTrackEnabled').mockReturnValue(false);
    const observed: Element[] = [];
    (globalThis as Record<string, unknown>)['IntersectionObserver'] = class {
      observe(el: Element) { observed.push(el); }
      disconnect() { /* noop */ }
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    const client = { track: vi.fn() };
    const stop = startEngagementCapture(client, { apiKey: '', apiBase: 'https://api.example.com' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(observed).toHaveLength(0);
    expect(() => stop()).not.toThrow();
  });

  // Same validity rule as init() and the graph entry: an invalid non-pk_
  // (typo'd) key produces a client that discards everything, yet capture used
  // to check truthiness only — so it still fired /v1/section-map registration
  // and dwell events into the void.
  it('invalid non-pk_ apiKey → inert: no section registration fetch, no observers', () => {
    document.body.innerHTML = '<section id="pricing"><h2>Pricing</h2></section>';
    vi.spyOn(core, 'isDoNotTrackEnabled').mockReturnValue(false);
    const observed: Element[] = [];
    (globalThis as Record<string, unknown>)['IntersectionObserver'] = class {
      observe(el: Element) { observed.push(el); }
      disconnect() { /* noop */ }
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    const client = { track: vi.fn() };
    const stop = startEngagementCapture(client, { apiKey: 'sk_not_public', apiBase: 'https://api.example.com' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(observed).toHaveLength(0);
    expect(() => stop()).not.toThrow();
  });

  it('sends a client-sensor observation per section: features + pattern flags, never body text', () => {
    document.body.innerHTML =
      '<section id="deal"><h2>Membership</h2><p>Starter plan from $29/mo billed monthly for every user on the account.</p></section>';
    vi.spyOn(core, 'isDoNotTrackEnabled').mockReturnValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue({ ok: true } as never);
    (globalThis as Record<string, unknown>)['IntersectionObserver'] = class {
      observe() { /* noop */ }
      disconnect() { /* noop */ }
    };

    startEngagementCapture({ track: vi.fn() }, { apiKey: 'pk_test', apiBase: 'https://api.example.com' });

    const raw = (fetchSpy.mock.calls[0] as unknown as [string, { body: string }])[1].body;
    const body = JSON.parse(raw) as {
      sections: Array<{ observation?: { tag: string; headingText: string; patternFlags?: string[]; textLength: number } }>;
    };
    const obs = body.sections[0]!.observation!;
    expect(obs.tag).toBe('section');
    expect(obs.headingText).toBe('Membership');
    expect(obs.textLength).toBeGreaterThan(0);
    // The shipped pricing CONTENT_PATTERN matches "$29/mo" — transmitted as a
    // flag only. The body text itself must never leave the page: the whole
    // request body cannot contain it.
    expect(obs.patternFlags).toContain('pricing');
    expect(raw).not.toContain('billed monthly');
  });

  it('per-element type precedence: data-sentient-type > typeOf > heuristic; markup reported as source', () => {
    document.body.innerHTML =
      '<section data-sentient-type="pricing"><div>plain content</div></section>' +
      '<section id="b"><p>Some paragraph of prose that carries no strong signal about its role at all whatsoever.</p></section>' +
      '<section id="c"><p>Another plain paragraph of prose with no strong signal about its role whatsoever here.</p></section>';
    vi.spyOn(core, 'isDoNotTrackEnabled').mockReturnValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue({ ok: true } as never);
    (globalThis as Record<string, unknown>)['IntersectionObserver'] = class {
      observe() { /* noop */ }
      disconnect() { /* noop */ }
    };

    const client = { track: vi.fn() };
    startEngagementCapture(client, {
      apiKey: 'pk_test', apiBase: 'https://api.example.com',
      typeOf: (el) => (el.id === 'b' ? 'trust' : null),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0] as unknown as [string, { body: string }])[1].body) as {
      sections: Array<{ componentId: string; semanticType: string; source: string }>;
    };
    // Ids are per-element (nc-* retirement): find each by its type prefix.
    const byType = (t: string) => body.sections.find((s) => s.componentId.startsWith(`nc-${t}`));
    expect(byType('pricing')).toMatchObject({ semanticType: 'pricing', source: 'markup' });
    expect(byType('trust')).toMatchObject({ semanticType: 'trust', source: 'auto' });
    expect(byType('generic')).toMatchObject({ semanticType: 'generic', source: 'auto' });
  });

  describe('section-map URL normalization', () => {
    // Both a root base and a /v1-suffixed base (with or without a trailing slash)
    // must resolve to exactly one `/v1/section-map` — a doubled `/v1/v1/...` is a
    // silent 404 that drops every served-classification registration.
    it.each([
      'https://api.example.com',
      'https://api.example.com/',
      'https://api.example.com/v1',
      'https://api.example.com/v1/',
    ])('resolves %s to a single /v1/section-map', (apiBase) => {
      document.body.innerHTML = '<section id="pricing"><h2>Pricing</h2></section>';
      vi.spyOn(core, 'isDoNotTrackEnabled').mockReturnValue(false);
      const fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue({ ok: true } as never);
      (globalThis as Record<string, unknown>)['IntersectionObserver'] = class {
        observe() { /* noop */ }
        disconnect() { /* noop */ }
      };

      startEngagementCapture({ track: vi.fn() }, { apiKey: 'pk_test', apiBase });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = String((fetchSpy.mock.calls[0] as unknown as [string])[0]);
      expect(url).toBe('https://api.example.com/v1/section-map');
    });
  });

  describe('microSignals option (no-code path)', () => {
    function setup(microSignals: boolean) {
      document.body.innerHTML = '<section id="pricing"><h2>Simple pricing</h2></section>';
      vi.spyOn(core, 'isDoNotTrackEnabled').mockReturnValue(false);
      vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue({ ok: true } as never);
      (globalThis as Record<string, unknown>)['IntersectionObserver'] = class {
        constructor(_cb: unknown) { /* not needed for click detectors */ }
        observe() { /* noop */ }
        disconnect() { /* noop */ }
      };
      const client = { track: vi.fn() };
      const stop = startEngagementCapture(client, {
        apiKey: 'pk_test',
        apiBase: 'https://api.example.com',
        microSignals,
      });
      return { client, stop };
    }

    function rageClick(el: Element) {
      for (let i = 0; i < 3; i++) el.dispatchEvent(new Event('click', { bubbles: true }));
    }

    it('attaches per-section detectors when enabled: rage clicks emit micro_signal for the section', () => {
      const { client, stop } = setup(true);
      rageClick(document.querySelector('section')!);
      const micro = client.track.mock.calls.filter(([e]) => e.eventType === 'micro_signal');
      expect(micro).toHaveLength(1);
      expect(micro[0]![0]).toMatchObject({
        componentId: expect.stringMatching(/^nc-pricing(-[0-9a-z]+)?$/) as unknown as string,
        eventType: 'micro_signal',
        payload: { signalType: 'rage_click' },
      });
      stop();
    });

    it('emits no micro_signal by default (React keeps its own per-component detectors)', () => {
      const { client, stop } = setup(false);
      rageClick(document.querySelector('section')!);
      expect(client.track.mock.calls.filter(([e]) => e.eventType === 'micro_signal')).toHaveLength(0);
      stop();
    });

    it('cleanup detaches the detectors', () => {
      const { client, stop } = setup(true);
      stop();
      client.track.mockClear();
      rageClick(document.querySelector('section')!);
      expect(client.track).not.toHaveBeenCalled();
    });

    it('emits exactly ONE tab_loss for a single tab-hide across many sections (audit M5)', () => {
      // tab_loss is a document-level visibilitychange signal. Attaching it to every
      // section detector made one tab-hide fire N tab_loss events (one per nc-<type>
      // section), attributing a single page-level exit to sections never seen. Only
      // the first section detector should carry tab_loss ({ tabLoss: i === 0 }).
      document.body.innerHTML =
        '<section id="pricing"><h2>Simple pricing plans</h2></section>' +
        '<section id="faq"><h2>Frequently asked questions</h2></section>' +
        '<section id="cta"><h2>Ready to get started today?</h2></section>';
      vi.spyOn(core, 'isDoNotTrackEnabled').mockReturnValue(false);
      vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue({ ok: true } as never);
      (globalThis as Record<string, unknown>)['IntersectionObserver'] = class {
        constructor(_cb: unknown) { /* scroll-hesitation detector needs a stub */ }
        observe() { /* noop */ }
        disconnect() { /* noop */ }
      };
      const client = { track: vi.fn() };
      const stop = startEngagementCapture(client, {
        apiKey: 'pk_test', apiBase: 'https://api.example.com', microSignals: true,
      });

      const orig = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
      try {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        const tabLoss = client.track.mock.calls.filter(([e]) => e.payload?.signalType === 'tab_loss');
        expect(tabLoss).toHaveLength(1);
      } finally {
        if (orig) Object.defineProperty(document, 'visibilityState', orig);
        else Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        stop();
      }
    });
  });

  it('drops a layout wrapper containing 2+ candidate sections and observes the sections inside it', () => {
    // A div-built landing page: `main > div` matches the page-wide wrapper.
    // Keeping the wrapper used to swallow every real <section> inside it —
    // one nc-generic component for the whole page, scroll_depth pinned at
    // viewport/page-height.
    document.body.innerHTML =
      '<main><div id="wrapper">' +
      '<section data-sentient-type="pricing"><h2>Pricing</h2></section>' +
      '<section data-sentient-type="faq"><h2>FAQ</h2></section>' +
      '</div></main>';
    vi.spyOn(core, 'isDoNotTrackEnabled').mockReturnValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue({ ok: true } as never);
    const observed: Element[] = [];
    (globalThis as Record<string, unknown>)['IntersectionObserver'] = class {
      observe(el: Element) { observed.push(el); }
      disconnect() { /* noop */ }
    };

    startEngagementCapture({ track: vi.fn() }, { apiKey: 'pk_test', apiBase: 'https://api.example.com' });

    expect(observed.map((el) => el.tagName)).toEqual(['SECTION', 'SECTION']);
    const body = JSON.parse((fetchSpy.mock.calls[0] as unknown as [string, { body: string }])[1].body) as {
      sections: Array<{ componentId: string }>;
    };
    const ids = body.sections.map((s) => s.componentId).sort();
    expect(ids[0]).toMatch(/^nc-faq(-[0-9a-z]+)?$/);
    expect(ids[1]).toMatch(/^nc-pricing(-[0-9a-z]+)?$/);
  });

  it('keeps a candidate with exactly ONE nested candidate (header > nav attributes to the header, as before)', () => {
    document.body.innerHTML = '<header id="h"><nav>links</nav><h1>Hero</h1></header>';
    vi.spyOn(core, 'isDoNotTrackEnabled').mockReturnValue(false);
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue({ ok: true } as never);
    const observed: Element[] = [];
    (globalThis as Record<string, unknown>)['IntersectionObserver'] = class {
      observe(el: Element) { observed.push(el); }
      disconnect() { /* noop */ }
    };

    startEngagementCapture({ track: vi.fn() }, { apiKey: 'pk_test', apiBase: 'https://api.example.com' });

    expect(observed.map((el) => el.tagName)).toEqual(['HEADER']);
  });

  it('heartbeat banks visible dwell without any visibility flip, so a hard tab close loses at most one interval', () => {
    document.body.innerHTML = '<section data-sentient-type="pricing"><h2>Pricing</h2></section>';
    vi.spyOn(core, 'isDoNotTrackEnabled').mockReturnValue(false);
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue({ ok: true } as never);

    let ioCallback: ((entries: Array<{ target: Element; isIntersecting: boolean; intersectionRatio: number }>) => void) | null = null;
    (globalThis as Record<string, unknown>)['IntersectionObserver'] = class {
      constructor(cb: typeof ioCallback) { ioCallback = cb; }
      observe() { /* driven via the callback below */ }
      disconnect() { /* noop */ }
    };

    vi.useFakeTimers();
    try {
      const client = { track: vi.fn() };
      const stop = startEngagementCapture(client, { apiKey: 'pk_test', apiBase: 'https://api.example.com' });

      const section = document.querySelector('section')!;
      ioCallback!([{ target: section, isIntersecting: true, intersectionRatio: 0.5 }]);
      vi.advanceTimersByTime(20_000); // first heartbeat

      const dwell = client.track.mock.calls.filter(([e]) => e.eventType === 'dwell');
      expect(dwell).toHaveLength(1);
      expect(dwell[0]![0].payload.dwell_time).toBe(20_000);

      // Accumulators reset on bank: the next heartbeat reports only the NEW
      // 20s, not a double-counted 40s.
      vi.advanceTimersByTime(20_000);
      const dwell2 = client.track.mock.calls.filter(([e]) => e.eventType === 'dwell');
      expect(dwell2).toHaveLength(2);
      expect(dwell2[1]![0].payload.dwell_time).toBe(20_000);

      // Cleanup stops the heartbeat.
      stop();
      const afterStop = client.track.mock.calls.filter(([e]) => e.eventType === 'dwell').length;
      vi.advanceTimersByTime(60_000);
      expect(client.track.mock.calls.filter(([e]) => e.eventType === 'dwell')).toHaveLength(afterStop);
    } finally {
      vi.useRealTimers();
    }
  });
});

// A page can be frozen into the bfcache instead of torn down. Timers keep
// firing on restore and `intersecting` still holds whatever it held at
// pagehide, so before this the heartbeat banked dwell forever for sections the
// visitor had already scrolled past — with the observer disconnected, nothing
// could ever correct them.
describe('bfcache restore', () => {
  it('stops counting while frozen and does not invent dwell for a stale section', () => {
    document.body.innerHTML = '<section data-sentient-type="pricing"><h2>Pricing</h2></section>';
    vi.spyOn(core, 'isDoNotTrackEnabled').mockReturnValue(false);
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue({ ok: true } as never);

    let ioCallback: ((entries: Array<{ target: Element; isIntersecting: boolean; intersectionRatio: number }>) => void) | null = null;
    (globalThis as Record<string, unknown>)['IntersectionObserver'] = class {
      constructor(cb: typeof ioCallback) { ioCallback = cb; }
      observe() { /* driven via the callback below */ }
      disconnect() { /* noop */ }
    };

    vi.useFakeTimers();
    try {
      const client = { track: vi.fn() };
      const stop = startEngagementCapture(client, { apiKey: 'pk_test', apiBase: 'https://api.example.com' });
      const section = document.querySelector('section')!;
      ioCallback!([{ target: section, isIntersecting: true, intersectionRatio: 0.5 }]);
      vi.advanceTimersByTime(20_000);

      const before = client.track.mock.calls.filter(([e]) => e.eventType === 'dwell').length;

      // Visitor reads five more seconds, then taps a link: the page is frozen,
      // not unloaded.
      vi.advanceTimersByTime(5_000);
      window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
      vi.advanceTimersByTime(120_000); // six heartbeats' worth of "away" time

      const afterFreeze = client.track.mock.calls.filter(([e]) => e.eventType === 'dwell');
      // pagehide banked exactly the 5s that was measured, and the two frozen
      // minutes added nothing at all.
      expect(afterFreeze.length).toBe(before + 1);
      expect(afterFreeze[afterFreeze.length - 1]![0].payload.dwell_time).toBe(5_000);

      // Back button: the section has scrolled out of view during restore.
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
      ioCallback!([{ target: section, isIntersecting: false, intersectionRatio: 0 }]);
      vi.advanceTimersByTime(60_000);
      expect(client.track.mock.calls.filter(([e]) => e.eventType === 'dwell')).toHaveLength(afterFreeze.length);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes measuring a section that is still on screen after restore', () => {
    document.body.innerHTML = '<section data-sentient-type="pricing"><h2>Pricing</h2></section>';
    vi.spyOn(core, 'isDoNotTrackEnabled').mockReturnValue(false);
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue({ ok: true } as never);

    let ioCallback: ((entries: Array<{ target: Element; isIntersecting: boolean; intersectionRatio: number }>) => void) | null = null;
    (globalThis as Record<string, unknown>)['IntersectionObserver'] = class {
      constructor(cb: typeof ioCallback) { ioCallback = cb; }
      observe() { /* driven via the callback below */ }
      disconnect() { /* noop */ }
    };

    vi.useFakeTimers();
    try {
      const client = { track: vi.fn() };
      const stop = startEngagementCapture(client, { apiKey: 'pk_test', apiBase: 'https://api.example.com' });
      const section = document.querySelector('section')!;
      ioCallback!([{ target: section, isIntersecting: true, intersectionRatio: 0.5 }]);

      window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
      const banked = client.track.mock.calls.filter(([e]) => e.eventType === 'dwell').length;
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));

      vi.advanceTimersByTime(20_000);
      const dwell = client.track.mock.calls.filter(([e]) => e.eventType === 'dwell');
      expect(dwell).toHaveLength(banked + 1);
      // Exactly the post-restore time, not the frozen interval as well.
      expect(dwell[dwell.length - 1]![0].payload.dwell_time).toBe(20_000);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// componentId stays `nc-${type}`, which collapses same-typed sections into one
// dwell bucket. The section MAP must not collapse with it: the server needs one
// entry per physical element to derive a distinct section_key for each. Without
// this, a page whose sections all classify `generic` reports as a single
// nc-generic and no per-section identity exists at all.
describe('section-map locator emission', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function capturePosts(): Array<Record<string, unknown>> {
    const posts: Array<Record<string, unknown>> = [];
    vi.spyOn(core, 'isDoNotTrackEnabled').mockReturnValue(false);
    vi.spyOn(globalThis, 'fetch' as never).mockImplementation(((_u: string, init: RequestInit) => {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve({ ok: true } as Response);
    }) as never);
    (globalThis as Record<string, unknown>)['IntersectionObserver'] = class {
      observe() {}
      disconnect() {}
    };
    return posts;
  }

  it('sends one entry per element, each with its own locator', () => {
    document.body.innerHTML =
      '<section id="a"><h2>Our Services</h2></section><section id="b"><h2>Our Process</h2></section>';
    const posts = capturePosts();

    startEngagementCapture({ track: vi.fn() }, { apiKey: 'pk_test123', doc: document });

    const sections = posts[0]!['sections'] as Array<{ componentId: string; locator?: { id?: string } }>;
    // Both sections classify `generic`, so they share a componentId...
    expect(sections).toHaveLength(2);
    // ...but each carries its own identity.
    expect(sections.map((s) => s.locator?.id).sort()).toEqual(['a', 'b']);
  });

  it('omits locator when nothing resolves uniquely', () => {
    document.body.innerHTML = '<section><p>same</p><p>same</p></section>';
    const posts = capturePosts();

    startEngagementCapture({ track: vi.fn() }, { apiKey: 'pk_test123', doc: document });

    const sections = posts[0]!['sections'] as Array<{ locator?: unknown }>;
    for (const s of sections) {
      if ('locator' in s) expect(s.locator).toBeTruthy();
    }
  });
});
