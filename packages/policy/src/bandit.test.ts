import { describe, expect, it } from 'vitest';
import {
  invalidPosteriorArms,
  isValidBetaShape,
  sampleArm,
  sampleBeta,
  usablePosteriors,
  type ArmPosterior,
} from './bandit';

// Deterministic LCG so distribution assertions never flake.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('sampleBeta', () => {
  it('returns values strictly inside (0, 1)', () => {
    const rand = lcg(42);
    for (let i = 0; i < 200; i++) {
      const v = sampleBeta(2, 5, rand);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('concentrates near alpha/(alpha+beta) for large counts', () => {
    const rand = lcg(7);
    let sum = 0;
    const n = 500;
    for (let i = 0; i < n; i++) sum += sampleBeta(900, 100, rand);
    const mean = sum / n;
    expect(mean).toBeGreaterThan(0.85);
    expect(mean).toBeLessThan(0.95);
  });

  it('handles shape parameters below 1 (the recursive Gamma branch)', () => {
    const rand = lcg(13);
    for (let i = 0; i < 100; i++) {
      const v = sampleBeta(0.5, 0.5, rand);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('defaults rand to Math.random', () => {
    const v = sampleBeta(1, 1);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe('sampleArm', () => {
  it('returns null for an empty arm list', () => {
    expect(sampleArm([])).toBeNull();
  });

  it('returns the sole arm without consuming randomness', () => {
    let called = 0;
    const rand = () => {
      called++;
      return 0.5;
    };
    expect(sampleArm([{ arm: 'only', alpha: 1, beta: 1 }], rand)).toBe('only');
    expect(called).toBe(0);
  });

  it('overwhelmingly picks the dominant posterior', () => {
    const rand = lcg(1234);
    const arms: ArmPosterior[] = [
      { arm: 'winner', alpha: 900, beta: 100 },
      { arm: 'loser', alpha: 10, beta: 90 },
    ];
    let wins = 0;
    for (let i = 0; i < 300; i++) if (sampleArm(arms, rand) === 'winner') wins++;
    expect(wins).toBeGreaterThan(280);
  });

  it('explores every arm under uniform priors', () => {
    const rand = lcg(99);
    const arms: ArmPosterior[] = [
      { arm: 'a', alpha: 1, beta: 1 },
      { arm: 'b', alpha: 1, beta: 1 },
      { arm: 'c', alpha: 1, beta: 1 },
    ];
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(sampleArm(arms, rand)!);
    expect(seen.size).toBe(3);
  });
});

// Audit I10: corrupt posteriors. NaN on the first arm used to win every argmax
// (nothing compares greater than NaN), a shape in (−1, 0) exploded, 0/0 was NaN.
describe('corrupt posteriors', () => {
  const BAD: Array<[string, number, number]> = [
    ['NaN alpha', NaN, 5],
    ['NaN beta', 5, NaN],
    ['both NaN', NaN, NaN],
    ['alpha = beta = 0', 0, 0],
    ['zero alpha', 0, 5],
    ['negative shape in (−1, 0)', -0.5, 5],
    ['negative shape ≤ −1', 3, -2],
    ['+Infinity', Infinity, 5],
    ['−Infinity', 5, -Infinity],
  ];

  it('isValidBetaShape accepts finite positive shapes, fractional ones included', () => {
    expect(isValidBetaShape(1, 1)).toBe(true);
    expect(isValidBetaShape(0.5, 0.01)).toBe(true);
    expect(isValidBetaShape(900, 100)).toBe(true);
    for (const [, a, b] of BAD) expect(isValidBetaShape(a, b)).toBe(false);
  });

  it.each(BAD)('sampleBeta returns NaN ("no draw") for %s', (_name, a, b) => {
    expect(sampleBeta(a, b, lcg(1))).toBeNaN();
  });

  it.each(BAD)('sampleArm never serves a corrupt FIRST arm against a valid one (%s)', (_name, a, b) => {
    const rand = lcg(2024);
    const arms: ArmPosterior[] = [
      { arm: 'corrupt', alpha: a, beta: b },
      { arm: 'weak', alpha: 2, beta: 200 },
    ];
    for (let i = 0; i < 500; i++) expect(sampleArm(arms, rand)).toBe('weak');
  });

  it.each(BAD)('sampleArm never serves a corrupt arm in any position (%s)', (_name, a, b) => {
    const rand = lcg(77);
    const arms: ArmPosterior[] = [
      { arm: 'x', alpha: 5, beta: 95 },
      { arm: 'corrupt', alpha: a, beta: b },
      { arm: 'y', alpha: 6, beta: 94 },
    ];
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(sampleArm(arms, rand)!);
    expect(seen).toEqual(new Set(['x', 'y']));
  });

  it('excludes rather than resetting to Beta(1,1): a reset arm would beat a measured 5% arm ~95% of the time', () => {
    // The capture exclusion prevents: a corrupt row never heals (close-out adds
    // to NaN), so a prior-reset arm would hold this share indefinitely.
    const rand = lcg(5);
    let resetWins = 0;
    for (let i = 0; i < 1000; i++) {
      if (sampleArm([{ arm: 'reset', alpha: 1, beta: 1 }, { arm: 'measured', alpha: 50, beta: 950 }], rand) === 'reset') resetWins++;
    }
    expect(resetWins).toBeGreaterThan(900);
    for (let i = 0; i < 200; i++) {
      expect(sampleArm([{ arm: 'corrupt', alpha: NaN, beta: NaN }, { arm: 'measured', alpha: 50, beta: 950 }], rand)).toBe('measured');
    }
  });

  it('draws uniformly when EVERY arm is corrupt — no arm captures traffic', () => {
    const rand = lcg(31);
    const arms: ArmPosterior[] = [
      { arm: 'a', alpha: NaN, beta: 1 },
      { arm: 'b', alpha: 0, beta: 0 },
      { arm: 'c', alpha: -0.5, beta: 3 },
    ];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const n = 3000;
    for (let i = 0; i < n; i++) counts[sampleArm(arms, rand)!]!++;
    for (const k of ['a', 'b', 'c']) {
      expect(counts[k]! / n).toBeGreaterThan(0.29);
      expect(counts[k]! / n).toBeLessThan(0.38);
    }
  });

  it('a lone usable arm is returned without a draw', () => {
    let called = 0;
    const rand = () => { called++; return 0.5; };
    expect(sampleArm([{ arm: 'bad', alpha: NaN, beta: 1 }, { arm: 'ok', alpha: 3, beta: 7 }], rand)).toBe('ok');
    expect(called).toBe(0);
  });

  it('leaves valid draws byte-identical: same picks, same rand consumption', () => {
    // Reference: the pre-guard loop, inlined.
    const legacy = (arms: ArmPosterior[], rand: () => number): string => {
      let best = arms[0]!;
      let bestSample = sampleBeta(best.alpha, best.beta, rand);
      for (let i = 1; i < arms.length; i++) {
        const s = sampleBeta(arms[i]!.alpha, arms[i]!.beta, rand);
        if (s > bestSample) { best = arms[i]!; bestSample = s; }
      }
      return best.arm;
    };
    const arms: ArmPosterior[] = [
      { arm: 'a', alpha: 3, beta: 40 }, { arm: 'b', alpha: 0.7, beta: 9 }, { arm: 'c', alpha: 12, beta: 88 },
    ];
    const r1 = lcg(11);
    const r2 = lcg(11);
    for (let i = 0; i < 300; i++) expect(sampleArm(arms, r1)).toBe(legacy(arms, r2));
    expect(r1()).toBe(r2());
  });

  it('usablePosteriors maps usable arms back to their input positions', () => {
    const arms = [
      { arm: 'a', alpha: 1, beta: 2 }, { arm: 'b', alpha: NaN, beta: 2 }, { arm: 'c', alpha: 4, beta: 1 },
    ];
    expect(usablePosteriors(arms)).toEqual({ arms: [arms[0], arms[2]], index: [0, 2] });
    expect(invalidPosteriorArms(arms)).toEqual([arms[1]]);
    expect(usablePosteriors([{ arm: 'x', alpha: 0, beta: 0 }, { arm: 'y', alpha: NaN, beta: 1 }])).toEqual({
      arms: [{ arm: 'x', alpha: 1, beta: 1 }, { arm: 'y', alpha: 1, beta: 1 }],
      index: [0, 1],
    });
  });
});
