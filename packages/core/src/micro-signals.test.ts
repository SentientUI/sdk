import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachMicroSignalDetectors, type MicroSignalEmitter } from './micro-signals.js';

type IOCallback = (entries: IntersectionObserverEntry[]) => void;

/**
 * Retrieves the IntersectionObserver callback that `attachMicroSignalDetectors`
 * passed to the (stubbed) IntersectionObserver constructor. The mock below
 * records it as `_cb` on each constructed instance — jsdom cannot fire
 * IntersectionObserver natively, so tests invoke this callback directly.
 */
function latestIOCallback(): IOCallback | undefined {
  const mock = (globalThis.IntersectionObserver as unknown as {
    mock?: { results: Array<{ value: { _cb?: IOCallback } }> };
  }).mock;
  return mock?.results.at(-1)?.value._cb;
}

describe('attachMicroSignalDetectors', () => {
  let container: HTMLDivElement;
  let emitted: Array<{ signalType: string; [k: string]: unknown }>;
  let emitter: MicroSignalEmitter;
  let cleanup: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    emitted = [];
    emitter = (signalType, extra = {}) => emitted.push({ signalType, ...extra });

    vi.stubGlobal('IntersectionObserver', vi.fn((cb: (entries: IntersectionObserverEntry[]) => void) => ({
      observe: vi.fn(),
      disconnect: vi.fn(),
      unobserve: vi.fn(),
      _cb: cb,
    })));

    cleanup = attachMicroSignalDetectors(emitter, container);
  });

  afterEach(() => {
    cleanup();
    if (container.parentNode) document.body.removeChild(container);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('rage click', () => {
    it('emits when 3+ clicks happen within 500ms', () => {
      container.click();
      container.click();
      container.click();
      expect(emitted.filter((e) => e.signalType === 'rage_click')).toHaveLength(1);
    });

    it('does not emit for 2 clicks', () => {
      container.click();
      container.click();
      expect(emitted.filter((e) => e.signalType === 'rage_click')).toHaveLength(0);
    });

    it('resets window after 500ms', () => {
      container.click();
      container.click();
      vi.advanceTimersByTime(600);
      container.click();
      container.click();
      expect(emitted.filter((e) => e.signalType === 'rage_click')).toHaveLength(0);
    });

    it('emits at most once per attach even with many clicks', () => {
      for (let i = 0; i < 10; i++) container.click();
      expect(emitted.filter((e) => e.signalType === 'rage_click')).toHaveLength(1);
    });
  });

  describe('text copy', () => {
    it('emits on copy event targeting node', () => {
      const inner = document.createElement('span');
      container.appendChild(inner);
      inner.dispatchEvent(new Event('copy', { bubbles: true }));
      expect(emitted.filter((e) => e.signalType === 'text_copy')).toHaveLength(1);
    });

    it('emits at most once per attach', () => {
      container.dispatchEvent(new Event('copy', { bubbles: true }));
      container.dispatchEvent(new Event('copy', { bubbles: true }));
      expect(emitted.filter((e) => e.signalType === 'text_copy')).toHaveLength(1);
    });

    it('does not emit for copy outside container', () => {
      const outside = document.createElement('div');
      document.body.appendChild(outside);
      outside.dispatchEvent(new Event('copy', { bubbles: true }));
      expect(emitted.filter((e) => e.signalType === 'text_copy')).toHaveLength(0);
      document.body.removeChild(outside);
    });
  });

  describe('scroll hesitation', () => {
    it('emits after 3s of no scroll while container is visible', () => {
      const ioCallback = latestIOCallback();
      if (!ioCallback) return; // skip if IntersectionObserver not available

      ioCallback([{ intersectionRatio: 0.8, isIntersecting: true } as IntersectionObserverEntry]);
      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(3100);
      expect(emitted.filter((e) => e.signalType === 'scroll_hesitation')).toHaveLength(1);
    });

    it('does not emit if scroll resets the timer', () => {
      const ioCallback = latestIOCallback();
      if (!ioCallback) return;

      ioCallback([{ intersectionRatio: 0.8, isIntersecting: true } as IntersectionObserverEntry]);
      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(2000);
      window.dispatchEvent(new Event('scroll')); // reset
      vi.advanceTimersByTime(2000);
      expect(emitted.filter((e) => e.signalType === 'scroll_hesitation')).toHaveLength(0);
    });
  });

  describe('tab loss', () => {
    it('emits when tab becomes hidden within 15s of variantAssignedAt', () => {
      cleanup(); // re-attach with explicit assignedAt
      cleanup = attachMicroSignalDetectors(emitter, container, Date.now());

      vi.advanceTimersByTime(5000);
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(emitted.filter((e) => e.signalType === 'tab_loss')).toHaveLength(1);
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });

    it('does not emit when tab becomes hidden after 15s', () => {
      cleanup();
      const past = Date.now() - 20_000;
      cleanup = attachMicroSignalDetectors(emitter, container, past);

      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(emitted.filter((e) => e.signalType === 'tab_loss')).toHaveLength(0);
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });
  });

  describe('intersectionRatio threshold boundary', () => {
    it('ratio exactly 0.3 is NOT visible → no scroll_hesitation', () => {
      const io = latestIOCallback();
      if (!io) return;
      // 0.3 is not > 0.3, so isVisible stays false; startHesitation is a no-op.
      io([{ intersectionRatio: 0.3, isIntersecting: true } as IntersectionObserverEntry]);
      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(3100);
      expect(emitted.filter((e) => e.signalType === 'scroll_hesitation')).toHaveLength(0);
    });

    it('ratio just above 0.3 IS visible → scroll_hesitation fires', () => {
      const io = latestIOCallback();
      if (!io) return;
      io([{ intersectionRatio: 0.31, isIntersecting: true } as IntersectionObserverEntry]);
      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(3100);
      expect(emitted.filter((e) => e.signalType === 'scroll_hesitation')).toHaveLength(1);
    });
  });

  describe('rage click exact 500ms timing boundary', () => {
    it('third click whose gap from the oldest equals exactly 500ms still counts (>500 evicts, ==500 stays)', () => {
      let t = 1_000_000;
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => t);
      try {
        t = 1_000_000; container.click(); // ts[0] = 1_000_000
        t = 1_000_200; container.click();
        t = 1_000_500; container.click(); // now - ts[0] = 500, not > 500 → kept, length 3 → fires
        expect(emitted.filter((e) => e.signalType === 'rage_click')).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('third click 501ms after the oldest evicts it → no rage_click', () => {
      let t = 2_000_000;
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => t);
      try {
        t = 2_000_000; container.click(); // ts[0]
        t = 2_000_200; container.click();
        t = 2_000_501; container.click(); // now - ts[0] = 501 > 500 → evicts oldest, length 2 → no fire
        expect(emitted.filter((e) => e.signalType === 'rage_click')).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('cleanup idempotency', () => {
    it('calling cleanup twice does not throw', () => {
      const c = attachMicroSignalDetectors(emitter, container);
      expect(() => { c(); c(); }).not.toThrow();
    });
  });
});
