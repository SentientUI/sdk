import { describe, expect, it } from 'vitest';
import { contextRootPosteriors, relativeEffect, sampleContextArm, sampleContextArmNested, type ContextArmCounts } from './context-prior';

const mean = (p: { alpha: number; beta: number }): number => p.alpha / (p.alpha + p.beta);
const row = (context: string, arm: string, exposures: number, conversions: number): ContextArmCounts =>
  ({ context, arm, exposures, conversions });

describe('contextRootPosteriors', () => {
  it("the reference borrows only from its own context — another context's base rate never reaches it", () => {
    const rows = [
      row('new', 'original', 100_000, 2_000),       // 2%
      row('carted', 'original', 50, 6),             // 12%
    ];
    const post = contextRootPosteriors(rows, 'carted', ['original'], 'original').get('original')!;
    // Shrunk toward the carted context's own all-arm rate (here: itself), so it
    // stays near 12% however much 2% traffic exists elsewhere.
    expect(mean(post)).toBeGreaterThan(0.1);
  });

  it('a context-only arm with no data starts at the reference rate in that context', () => {
    const rows = [
      row('new', 'original', 100_000, 2_000),
      row('carted', 'original', 2_000, 240),        // 12%
    ];
    const posts = contextRootPosteriors(rows, 'carted', ['original', 'reminder'], 'original');
    // Centred on the reference's 12% (plus an empty cell's Beta(1,1)
    // optimism), never on the 2% that dominates 'new'.
    const ref = mean(posts.get('original')!);
    const reminder = mean(posts.get('reminder')!);
    expect(Math.abs(reminder - ref)).toBeLessThan(0.03);
  });

  it('carries an effect seen elsewhere into a thin context, at that context\'s own base rate', () => {
    const rows = [
      // +50% odds-ish in 'new', on plenty of traffic.
      row('new', 'original', 50_000, 1_000),        // 2%
      row('new', 'better', 50_000, 1_500),          // 3%
      row('lapsed', 'original', 400, 40),           // 10%
    ];
    const posts = contextRootPosteriors(rows, 'lapsed', ['original', 'better'], 'original');
    const ref = mean(posts.get('original')!);
    const better = mean(posts.get('better')!);
    expect(better).toBeGreaterThan(ref);
    // The prior is lapsed's ~10% moved by the effect (logistic(logit .1 + .42)
    // ≈ 14%, plus an empty cell's optimism), never near the 3% 'new' rate.
    expect(better).toBeGreaterThan(0.12);
    expect(better).toBeLessThan(0.2);
  });

  it('sums rows of the same (context, arm)', () => {
    const split = [row('carted', 'original', 60, 6), row('carted', 'original', 40, 4)];
    const whole = [row('carted', 'original', 100, 10)];
    expect(contextRootPosteriors(split, 'carted', ['original'], 'original').get('original'))
      .toEqual(contextRootPosteriors(whole, 'carted', ['original'], 'original').get('original'));
  });

  it('an empty context yields flat-ish posteriors, never NaN', () => {
    const posts = contextRootPosteriors([], 'lapsed', ['original', 'x'], 'original');
    for (const p of posts.values()) {
      expect(Number.isFinite(p.alpha) && Number.isFinite(p.beta)).toBe(true);
      expect(mean(p)).toBeCloseTo(0.5, 5);
    }
  });
});

describe('relativeEffect', () => {
  it('is 0 for the reference and for an arm never served outside the context', () => {
    const rows = [row('carted', 'original', 100, 12), row('carted', 'reminder', 100, 8)];
    expect(relativeEffect(rows, 'original', 'original', 'carted')).toBe(0);
    expect(relativeEffect(rows, 'reminder', 'original', 'carted')).toBe(0);
  });

  it("leaves the context's own data out", () => {
    const elsewhere = [row('new', 'original', 10_000, 200), row('new', 'b', 10_000, 300)];
    const withHere = [...elsewhere, row('carted', 'original', 10_000, 1_200), row('carted', 'b', 10_000, 100)];
    expect(relativeEffect(withHere, 'b', 'original', 'carted'))
      .toBeCloseTo(relativeEffect(elsewhere, 'b', 'original', 'carted'), 12);
  });

  it('shrinks a thinly measured effect toward 0 and keeps a well measured one', () => {
    const thin = [row('new', 'original', 20, 1), row('new', 'b', 20, 4)];
    const thick = [row('new', 'original', 20_000, 1_000), row('new', 'b', 20_000, 4_000)];
    const raw = Math.log(0.2 / 0.8) - Math.log(0.05 / 0.95);
    expect(relativeEffect(thin, 'b', 'original', 'carted')).toBeLessThan(raw / 2);
    expect(relativeEffect(thick, 'b', 'original', 'carted')).toBeGreaterThan(raw * 0.95);
  });
});

describe('sampleContextArm', () => {
  function lcg(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x = (x * 1664525 + 1013904223) >>> 0;
      return x / 0x100000000;
    };
  }

  it('in a thin context, mostly picks the arm whose effect is well known elsewhere', () => {
    const rows = [
      row('new', 'original', 50_000, 1_000),
      row('new', 'better', 50_000, 1_500),
      row('lapsed', 'original', 30, 3),
      row('lapsed', 'better', 30, 3),
    ];
    const rand = lcg(3);
    let better = 0;
    for (let i = 0; i < 2_000; i++) {
      if (sampleContextArm(rows, 'lapsed', ['original', 'better'], 'original', rand) === 'better') better++;
    }
    expect(better / 2_000).toBeGreaterThan(0.7);
  });

  it('with no knowledge anywhere, is an even coin', () => {
    const rand = lcg(5);
    let x = 0;
    for (let i = 0; i < 4_000; i++) {
      if (sampleContextArm([], 'carted', ['original', 'x'], 'original', rand) === 'x') x++;
    }
    expect(x / 4_000).toBeGreaterThan(0.45);
    expect(x / 4_000).toBeLessThan(0.55);
  });
});

describe('sampleContextArmNested', () => {
  function lcg(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x = (x * 1664525 + 1013904223) >>> 0;
      return x / 0x100000000;
    };
  }
  const c = (context: string, arm: string, segment: string, persona: string, exposures: number, conversions: number) =>
    ({ context, arm, segment, persona, exposures, conversions });
  const share = (pick: () => string, arm: string, n = 3_000): number => {
    let k = 0;
    for (let i = 0; i < n; i++) if (pick() === arm) k++;
    return k / n;
  };

  // Root of 'carted': b clearly better.
  const root = [
    c('carted', 'original', '__all__', '__all__', 4_000, 480),
    c('carted', 'b', '__all__', '__all__', 4_000, 640),
  ];

  it('with no cell, the root draw decides', () => {
    const rand = lcg(11);
    expect(share(() => sampleContextArmNested(root, 'carted', ['original', 'b'], 'original', null, rand), 'b')).toBeGreaterThan(0.9);
  });

  it('a thin cell with no evidence either way serves at its root', () => {
    // Three visits each, no conversions: nothing to tell the arms apart, so
    // the root's preference for b carries through.
    const rows = [...root, c('carted', 'original', 'mobile:social', 'deal_seeker', 3, 0), c('carted', 'b', 'mobile:social', 'deal_seeker', 3, 0)];
    const rand = lcg(12);
    const cell = { segment: 'mobile:social', persona: 'deal_seeker' };
    expect(share(() => sampleContextArmNested(rows, 'carted', ['original', 'b'], 'original', cell, rand), 'b')).toBeGreaterThan(0.6);
  });

  it('a thick cell that disagrees with the root serves its own winner', () => {
    const rows = [
      ...root,
      c('carted', 'original', 'mobile:social', 'deal_seeker', 2_000, 400),
      c('carted', 'b', 'mobile:social', 'deal_seeker', 2_000, 200),
    ];
    const rand = lcg(13);
    const cell = { segment: 'mobile:social', persona: 'deal_seeker' };
    expect(share(() => sampleContextArmNested(rows, 'carted', ['original', 'b'], 'original', cell, rand), 'original')).toBeGreaterThan(0.9);
  });

  it("never reads another context's cells for the nested stage", () => {
    const rows = [
      ...root,
      c('new', 'original', 'mobile:social', 'deal_seeker', 2_000, 400),
      c('new', 'b', 'mobile:social', 'deal_seeker', 2_000, 20),
    ];
    const rand = lcg(14);
    const cell = { segment: 'mobile:social', persona: 'deal_seeker' };
    expect(share(() => sampleContextArmNested(rows, 'carted', ['original', 'b'], 'original', cell, rand), 'b')).toBeGreaterThan(0.6);
  });
});
