import { describe, expect, it } from 'vitest';
import { SHRINKAGE_M, shrunkPosterior } from './shrinkage';

const mean = (p: { alpha: number; beta: number }): number => p.alpha / (p.alpha + p.beta);
const mass = (p: { alpha: number; beta: number }): number => p.alpha + p.beta;
/** Standard deviation of Beta(alpha, beta) — how much Thompson Sampling explores this arm. */
const sd = (p: { alpha: number; beta: number }): number =>
  Math.sqrt((p.alpha * p.beta) / ((p.alpha + p.beta) ** 2 * (p.alpha + p.beta + 1)));

/** Beta posterior for a cell with `n` exposures and `c` conversions (posteriorOfCounts). */
const cell = (n: number, c: number): { alpha: number; beta: number } => ({
  alpha: c + 1,
  beta: Math.max(0, n - c) + 1,
});

describe('shrinkage', () => {
  it('pins SHRINKAGE_M at 20', () => {
    expect(SHRINKAGE_M).toBe(20);
  });

  it('a cell with no data of its own sits near its parent rate', () => {
    // Parent rate 0.25; the cell's own Beta(1,1) keeps a mild pull toward 0.5.
    const got = shrunkPosterior(cell(0, 0), { alpha: 10, beta: 30 });
    expect(mean(got)).toBeCloseTo(0.283, 3);
  });

  // The STAT-01 regression. The prior must be worth a FIXED number of
  // pseudo-observations, never a copy of the parent's counts — otherwise a
  // thin cell inherits the parent's confidence along with its rate.
  it('adds at most m pseudo-observations however large the parent is', () => {
    const thin = cell(20, 4);
    for (const parent of [
      { alpha: 2001, beta: 98001 }, // 100k exposures at 2%
      { alpha: 20_001, beta: 980_001 }, // 1M exposures at 2%
    ]) {
      const got = shrunkPosterior(thin, parent);
      expect(mass(got) - mass(thin)).toBeLessThanOrEqual(SHRINKAGE_M);
      expect(mass(got) - mass(thin)).toBeGreaterThan(SHRINKAGE_M * 0.99);
    }
  });

  it('leaves a thin cell wide enough for Thompson Sampling to keep exploring it', () => {
    const thin = cell(20, 4); // 20% on 20 exposures
    const got = shrunkPosterior(thin, { alpha: 2001, beta: 98001 });
    // Its own evidence alone justifies sd ≈ 0.079; pooling may tighten that,
    // but nowhere near the ~0.002 the sample-size-copying form produced.
    expect(sd(got)).toBeGreaterThan(0.02);
    expect(sd(got)).toBeLessThan(sd(thin));
  });

  it('shrinks a thin cell toward the parent rate without erasing its own signal', () => {
    const got = shrunkPosterior(cell(20, 4), { alpha: 2001, beta: 98001 });
    // True cell rate 0.20, parent rate 0.02 → lands between, nearer the parent.
    expect(mean(got)).toBeGreaterThan(0.02);
    expect(mean(got)).toBeLessThan(0.20);
    expect(mean(got)).toBeCloseTo(0.129, 3);
  });

  it('detaches as the cell accumulates its own data', () => {
    const parent = { alpha: 2001, beta: 98001 }; // 2%
    const means = [20, 100, 500, 2_000, 10_000].map((n) =>
      mean(shrunkPosterior(cell(n, n * 0.2), parent)),
    );
    // Monotonically approaching the cell's own 20% as evidence accumulates.
    for (let i = 1; i < means.length; i++) expect(means[i]!).toBeGreaterThan(means[i - 1]!);
    expect(means.at(-1)!).toBeCloseTo(0.2, 2);
  });

  it('barely shrinks toward a parent that has no data itself', () => {
    // A flat Beta(1,1) parent knows nothing; injecting m confident pseudo-trials
    // of an unknown rate would be worse than not pooling at all.
    const own = cell(8, 4);
    const got = shrunkPosterior(own, { alpha: 1, beta: 1 });
    expect(mass(got) - mass(own)).toBeLessThan(2);
  });

  it('honors a custom m; m = 0 means no pooling at all', () => {
    expect(shrunkPosterior({ alpha: 4, beta: 6 }, { alpha: 100, beta: 100 }, 0)).toEqual({
      alpha: 4,
      beta: 6,
    });
  });

  it('is a no-op against a massless parent', () => {
    expect(shrunkPosterior({ alpha: 3, beta: 7 }, { alpha: 0, beta: 0 })).toEqual({
      alpha: 3,
      beta: 7,
    });
  });
});
