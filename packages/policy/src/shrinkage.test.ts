import { describe, expect, it } from 'vitest';
import { SHRINKAGE_M, shrunkPosterior } from './shrinkage';

describe('shrinkage', () => {
  it('pins SHRINKAGE_M at 20', () => {
    expect(SHRINKAGE_M).toBe(20);
  });

  it('fully pools at zero persona exposures (w = 1)', () => {
    expect(shrunkPosterior({ alpha: 1, beta: 1, exposures: 0 }, { alpha: 10, beta: 30 })).toEqual({
      alpha: 11,
      beta: 31,
    });
  });

  it('half-pools when exposures equal m (w = 0.5)', () => {
    expect(shrunkPosterior({ alpha: 3, beta: 5, exposures: 20 }, { alpha: 8, beta: 4 })).toEqual({
      alpha: 7,
      beta: 7,
    });
  });

  it('detaches as persona data accumulates (w = m / (m + exposures))', () => {
    // exposures = 180 → w = 20 / 200 = 0.1
    expect(shrunkPosterior({ alpha: 2, beta: 2, exposures: 180 }, { alpha: 10, beta: 20 })).toEqual({
      alpha: 3,
      beta: 4,
    });
  });

  it('honors a custom m; m = 0 means no pooling at all', () => {
    expect(shrunkPosterior({ alpha: 4, beta: 6, exposures: 50 }, { alpha: 100, beta: 100 }, 0)).toEqual({
      alpha: 4,
      beta: 6,
    });
  });

  it('pooled influence vanishes asymptotically', () => {
    const r = shrunkPosterior({ alpha: 5, beta: 5, exposures: 1_000_000 }, { alpha: 1000, beta: 1000 });
    expect(r.alpha).toBeGreaterThan(5);
    expect(r.alpha).toBeLessThan(5.05);
    expect(r.beta).toBeGreaterThan(5);
    expect(r.beta).toBeLessThan(5.05);
  });
});
