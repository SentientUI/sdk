import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startInteractionCollector, GAP_EDGES_MS } from './interaction-stats';

function stubCanvas(renderer: string | null): void {
  // jsdom has no WebGL; stub getContext so the renderer probe is deterministic
  // and the "Not implemented" virtual-console noise never appears.
  (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = renderer === null
    ? () => null
    : () => ({
        getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
        getParameter: () => renderer,
      });
}

let t = 0;
const now = () => t;

beforeEach(() => {
  t = 0;
  stubCanvas(null);
  document.body.innerHTML = '<main><input id="i"></main>';
  // Scroll tests set this with defineProperty, and it persists across tests —
  // the collector reads it once at start to seed `lastScrollY`, so a leftover
  // value silently shifts the next test's measured distance.
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  // jsdom implements matchMedia only in newer versions; define a default so the
  // reduced-motion probe has something to spy on.
  (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false }) as MediaQueryList;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('startInteractionCollector', () => {
  it('starts at zero, with environment fields filled, and never throws on stop', () => {
    const c = startInteractionCollector(document, now);
    const s = c.snapshot();
    expect(s.v).toBe(1);
    expect(s.mm).toBe(0);
    expect(s.clicks).toBe(0);
    expect(s.gaps).toEqual([0, 0, 0, 0, 0, 0]);
    expect(s.renderer).toBe('unknown');
    expect(s.vp).toEqual([window.innerWidth, window.innerHeight]);
    expect(s.dpr).toBe(window.devicePixelRatio || 1);
    expect(() => c.stop()).not.toThrow();
  });

  it('classifies a software renderer and a hardware renderer', () => {
    stubCanvas('Google SwiftShader');
    expect(startInteractionCollector(document, now).snapshot().renderer).toBe('sw');
    stubCanvas('ANGLE (Apple, Apple M2, OpenGL 4.1)');
    expect(startInteractionCollector(document, now).snapshot().renderer).toBe('hw');
  });

  it('accumulates visible time and pauses it while hidden', () => {
    const c = startInteractionCollector(document, now);
    t = 5000;
    expect(c.snapshot().active_ms).toBe(5000);
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    t = 9000;
    expect(c.snapshot().active_ms).toBe(5000);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    t = 10000;
    expect(c.snapshot().active_ms).toBe(6000);
    c.stop();
  });

  it('measures click hold time with Welford mean/std and counts teleport clicks', () => {
    const c = startInteractionCollector(document, now);
    // Two "human" clicks preceded by mouse motion with different hold times.
    for (const hold of [80, 120]) {
      document.dispatchEvent(new MouseEvent('mousemove'));
      t += 50;
      document.dispatchEvent(new MouseEvent('mousedown'));
      t += hold;
      document.dispatchEvent(new MouseEvent('mouseup'));
      document.dispatchEvent(new MouseEvent('click'));
      t += 500;
    }
    // One teleport click: no mousemove within 250 ms, no touch at all.
    t += 1000;
    document.dispatchEvent(new MouseEvent('mousedown'));
    t += 100;
    document.dispatchEvent(new MouseEvent('mouseup'));
    document.dispatchEvent(new MouseEvent('click'));
    const s = c.snapshot();
    expect(s.mm).toBe(2);
    expect(s.clicks).toBe(3);
    expect(s.hold_n).toBe(3);
    expect(s.hold_mean).toBe(100);
    expect(s.hold_std).toBeGreaterThan(10);
    expect(s.teleport).toBe(1);
    c.stop();
  });

  it('does not count a click as teleport right after a touch', () => {
    const c = startInteractionCollector(document, now);
    document.dispatchEvent(new Event('touchstart'));
    t += 100;
    document.dispatchEvent(new MouseEvent('click'));
    expect(c.snapshot().touches).toBe(1);
    expect(c.snapshot().teleport).toBe(0);
    c.stop();
  });

  it('separates typed input from assigned input', () => {
    const c = startInteractionCollector(document, now);
    const input = document.getElementById('i')!;
    // Typed: keydowns with varied intervals, one backspace.
    for (const [key, gap] of [['h', 0], ['e', 120], ['Backspace', 300], ['y', 90]] as const) {
      t += gap;
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      if (key !== 'Backspace') input.dispatchEvent(new InputEvent('input', { data: key, bubbles: true }));
    }
    let s = c.snapshot();
    expect(s.keydowns).toBe(4);
    expect(s.backspaces).toBe(1);
    expect(s.input_chars).toBe(3);
    expect(s.ik_cv).toBeGreaterThan(0.3);
    // Assigned: one input event carrying a whole string, no keydown.
    input.dispatchEvent(new InputEvent('input', { data: 'assigned-value', bubbles: true }));
    s = c.snapshot();
    expect(s.keydowns).toBe(4);
    expect(s.input_chars).toBe(3 + 'assigned-value'.length);
    c.stop();
  });

  it('buckets action gaps into the log histogram', () => {
    const c = startInteractionCollector(document, now);
    const gaps = [50, 200, 700, 2000, 6000, 20000];
    document.dispatchEvent(new MouseEvent('click')); // first action: no gap
    for (const g of gaps) {
      t += g;
      document.dispatchEvent(new MouseEvent('click'));
    }
    expect(c.snapshot().gaps).toEqual([1, 1, 1, 1, 1, 1]);
    expect(GAP_EDGES_MS).toEqual([100, 300, 1000, 3000, 10000]);
    c.stop();
  });

  it('reports a mousemove RATE, not just a count (a driver emits ~1 per click)', () => {
    const c = startInteractionCollector(document, now);
    // The measured Playwright shape: one mousemove per click over ~3 s.
    for (let i = 0; i < 3; i++) {
      document.dispatchEvent(new MouseEvent('mousemove'));
      t += 1000;
      document.dispatchEvent(new MouseEvent('click'));
    }
    const driver = c.snapshot();
    expect(driver.mm).toBe(3);
    // Non-zero, so an `mm === 0` test could never catch this — the rate is
    // what separates it from a person.
    expect(driver.mm_rate).toBeCloseTo(1.0, 1);
    c.stop();

    // A human over the same window emits an order of magnitude more.
    t = 0;
    const h = startInteractionCollector(document, now);
    for (let i = 0; i < 300; i++) document.dispatchEvent(new MouseEvent('mousemove'));
    t = 3000;
    expect(h.snapshot().mm_rate).toBeGreaterThan(50);
    h.stop();
  });

  it('records how many hold samples the mean and std rest on', () => {
    const c = startInteractionCollector(document, now);
    // Clicks whose mousedown and mouseup land in the same tick: hold is
    // genuinely zero-variance, and hold_n says the measurement really happened.
    for (let i = 0; i < 3; i++) {
      document.dispatchEvent(new MouseEvent('mousedown'));
      document.dispatchEvent(new MouseEvent('mouseup'));
      document.dispatchEvent(new MouseEvent('click'));
      t += 500;
    }
    let s = c.snapshot();
    expect(s.hold_n).toBe(3);
    expect(s.hold_mean).toBe(0);
    expect(s.hold_std).toBe(0);
    c.stop();

    // Clicks with no mousedown/mouseup at all look identical on mean and std,
    // and only hold_n tells them apart.
    t = 0;
    const b = startInteractionCollector(document, now);
    for (let i = 0; i < 3; i++) { document.dispatchEvent(new MouseEvent('click')); t += 500; }
    s = b.snapshot();
    expect(s.hold_n).toBe(0);
    expect(s.hold_mean).toBe(0);
    expect(s.hold_std).toBe(0);
    b.stop();
  });

  it('counts a scroll as an action in the gap histogram', () => {
    const c = startInteractionCollector(document, now);
    document.dispatchEvent(new MouseEvent('click'));
    t += 500;
    Object.defineProperty(window, 'scrollY', { value: 400, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    t += 500;
    Object.defineProperty(window, 'scrollY', { value: 900, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    // Three actions → two gaps. Before scrolls counted, this was one.
    expect(c.snapshot().gaps.reduce((a, b) => a + b, 0)).toBe(2);
    c.stop();
  });

  it('counts scroll distance, wheel events and keyboard navigation', () => {
    const c = startInteractionCollector(document, now);
    document.dispatchEvent(new WheelEvent('wheel'));
    Object.defineProperty(window, 'scrollY', { value: 400, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    Object.defineProperty(window, 'scrollY', { value: 100, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    const s = c.snapshot();
    expect(s.wheel).toBe(1);
    expect(s.scroll_px).toBe(700);
    expect(s.kb_nav).toBe(2);
    c.stop();
  });

  it('reads prefers-reduced-motion when matchMedia exists', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ matches: q.includes('reduce') } as MediaQueryList));
    expect(startInteractionCollector(document, now).snapshot().reduced_motion).toBe(true);
  });

  it('stops listening after stop()', () => {
    const c = startInteractionCollector(document, now);
    c.stop();
    document.dispatchEvent(new MouseEvent('mousemove'));
    expect(c.snapshot().mm).toBe(0);
  });

  it('serialises under 512 bytes', () => {
    const c = startInteractionCollector(document, now);
    for (let i = 0; i < 50; i++) document.dispatchEvent(new MouseEvent('mousemove'));
    expect(JSON.stringify(c.snapshot()).length).toBeLessThan(512);
    c.stop();
  });
});
