// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gradientStopsRgb, resetColorCanvas, toRgb } from './css-color.js';
import { sampleStyleVocabulary } from './style-sample.js';
import { captureRegionSkeleton } from './region-capture.js';

// Chrome reports Tailwind v4 colours as lab(); jsdom has no canvas. The fake
// canvas below converts exactly the lab() values Chrome gave for
// bodyshopmanchester.co.uk (2026-09-23), the way the real one paints them.
const LAB: Record<string, [number, number, number]> = {
  'lab(44.0605 29.0279 -86.0352)': [37, 99, 235], // bg-blue-600
  'lab(65.9269 -0.832707 -8.17473)': [156, 163, 175], // text-gray-400
  'lab(7.78673 1.82345 -15.0537)': [15, 23, 42], // slate-900
};
const TO_LAB: Record<string, string> = Object.fromEntries(Object.entries(LAB).map(([k, [r, g, b]]) => [`rgb(${r}, ${g}, ${b})`, k]));

function fakeCanvas(): void {
  let style = '#000000';
  let pixel: [number, number, number, number] = [0, 0, 0, 0];
  const ctx = {
    get fillStyle() { return style; },
    set fillStyle(v: string) {
      const m = /^rgba?\((\d+), (\d+), (\d+)/.exec(v);
      if (v === '#010203' || LAB[v] || m) style = v; // anything else: ignored, like a real canvas
    },
    clearRect() { pixel = [0, 0, 0, 0]; },
    fillRect() {
      const m = /^rgba?\((\d+), (\d+), (\d+)/.exec(style);
      const rgb = LAB[style] ?? (m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [1, 2, 3]);
      pixel = [rgb[0]!, rgb[1]!, rgb[2]!, 255];
    },
    getImageData() { return { data: pixel }; },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
}

/** Computed styles as Chrome reports them on a Tailwind v4 site: lab(). */
function labComputedStyles(): void {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
    const cs = real(el);
    const lab = (v: string) => v.replace(/rgba?\(\d+, \d+, \d+\)/g, (m) => TO_LAB[m] ?? m);
    return new Proxy(cs, {
      get(t, k) {
        const v = Reflect.get(t, k) as unknown;
        return (k === 'color' || k === 'backgroundColor' || k === 'backgroundImage') && typeof v === 'string' ? lab(v) : typeof v === 'function' ? v.bind(t) : v;
      },
    });
  });
}

beforeEach(() => {
  resetColorCanvas();
  fakeCanvas();
});
afterEach(() => vi.restoreAllMocks());

describe('toRgb', () => {
  it('converts lab() through the canvas and passes rgb/hex through untouched', () => {
    expect(toRgb('lab(44.0605 29.0279 -86.0352)', document)).toBe('rgb(37, 99, 235)');
    expect(toRgb('rgb(1, 2, 3)', document)).toBe('rgb(1, 2, 3)');
    expect(toRgb('#fff', document)).toBe('#fff');
    expect(toRgb('transparent', document)).toBe('rgba(0, 0, 0, 0)');
  });
  it('an unparsable colour is unknown, never the previous colour', () => {
    expect(toRgb('not-a-colour(1)', document)).toBe('');
  });
  it('no canvas: unknown rather than a guess', () => {
    resetColorCanvas();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    expect(toRgb('lab(44.0605 29.0279 -86.0352)', document)).toBe('');
  });
  it('keeps both stops of a gradient that mixes rgb and lab', () => {
    expect(gradientStopsRgb('linear-gradient(rgb(0, 0, 0) 0%, lab(7.78673 1.82345 -15.0537) 100%)', document)).toEqual(['rgb(0, 0, 0)', 'rgb(15, 23, 42)']);
  });
});

describe('capture on a Tailwind v4 page (the Bodyshop failure)', () => {
  beforeEach(() => {
    document.body.style.fontSize = '16px';
    document.body.innerHTML = `
      <section class="bg-gradient-to-b from-black to-slate-900" style="background-image: linear-gradient(rgb(0, 0, 0), rgb(15, 23, 42)); color: rgb(255,255,255)">
        <h2 class="text-3xl font-bold text-white" style="font-size: 36px; font-weight: 700; color: rgb(255,255,255)">Contact</h2>
        <p class="text-gray-400" style="color: rgb(156, 163, 175)">No pressure — just honest advice.</p>
        <div id="cta" class="flex gap-4">
          <a href="/contact" class="px-8 py-3 bg-blue-600 text-white rounded-lg" style="display:inline-block; padding: 12px 32px; background-color: rgb(37, 99, 235); color: rgb(255,255,255)">Get in touch</a>
        </div>
      </section>`;
    labComputedStyles();
  });

  it('the blue button is a primary button with its fill, grey text keeps its colour, the gradient keeps both stops', () => {
    const { entries } = sampleStyleVocabulary(document);
    expect(entries.find((e) => e.role === 'button-primary')?.computed.bg).toBe('rgb(37, 99, 235)');
    expect(entries.find((e) => e.classes === 'text-gray-400')?.computed.color).toBe('rgb(156, 163, 175)');
    const section = entries.find((e) => e.role === 'section')!;
    expect([section.computed.bg, section.computed.bgDark]).toEqual(['rgb(0, 0, 0)', 'rgb(15, 23, 42)']);
  });

  it('region capture: the button reads as filled, the ambient gradient keeps its slate stop', () => {
    const cap = captureRegionSkeleton(document.getElementById('cta')!);
    expect(cap.skeleton?.nodes[0]).toMatchObject({ role: 'action', filled: true, color: 'rgb(255, 255, 255)' });
    expect(cap.skeleton?.root).toMatchObject({ ambientBg: 'rgb(0, 0, 0)', ambientBgAlt: 'rgb(15, 23, 42)' });
  });
});

describe('inherited text colour', () => {
  it('flags a style whose colour comes from its parent, not one that sets its own', () => {
    document.body.style.fontSize = '16px';
    document.body.innerHTML = `
      <section style="color: rgb(255, 255, 255)">
        <a href="/x" class="px-6 py-4 bg-white/10 rounded-lg" style="display:inline-block; padding: 12px 24px; background-color: rgba(255, 255, 255, 0.1)">WhatsApp</a>
        <h2 class="text-3xl text-blue-400" style="font-size: 36px; font-weight: 700; color: rgb(96, 165, 250)">Contact</h2>
      </section>`;
    const { entries } = sampleStyleVocabulary(document);
    const glass = entries.find((e) => e.classes === 'px-6 py-4 bg-white/10 rounded-lg')!;
    expect(glass.computed).toMatchObject({ color: 'rgb(255, 255, 255)', inheritsColor: true });
    expect(entries.find((e) => e.classes === 'text-3xl text-blue-400')!.computed.inheritsColor).toBeUndefined();
  });
});
