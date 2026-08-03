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
      expect(evt.componentId).toBe('nc-pricing');
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
    const byId = Object.fromEntries(body.sections.map((s) => [s.componentId, s]));
    expect(byId['nc-pricing']).toEqual({ componentId: 'nc-pricing', semanticType: 'pricing', source: 'markup' });
    expect(byId['nc-trust']).toEqual({ componentId: 'nc-trust', semanticType: 'trust', source: 'auto' });
    expect(byId['nc-generic']).toEqual({ componentId: 'nc-generic', semanticType: 'generic', source: 'auto' });
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
        componentId: 'nc-pricing',
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
});
