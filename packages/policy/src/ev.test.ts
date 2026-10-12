import { describe, expect, it } from 'vitest';
import { EV_SHRINK_K, sampleArmEv, shrunkAvgValue, usableMultipliers } from './ev';
import { sampleArm, sampleBeta } from './bandit';

describe('shrunkAvgValue', () => {
  it('zero-count cells use the reference exactly (EV degrades to CVR ranking)', () => {
    expect(shrunkAvgValue({ valueSum: 0, valueCount: 0 }, 80)).toBe(80);
  });
  it('EB-shrinks the cell average toward the reference by count', () => {
    // avg 200, ref 100, count 20, k 20 → w = 0.5 → 150
    expect(shrunkAvgValue({ valueSum: 4000, valueCount: 20 }, 100)).toBeCloseTo(150, 5);
  });
  it('large counts converge on the cell average', () => {
    expect(shrunkAvgValue({ valueSum: 200_000, valueCount: 1000 }, 100)).toBeCloseTo(200 * (1000 / 1020) + 100 * (20 / 1020), 3);
  });
  it('a non-positive reference falls back to the raw cell average', () => {
    expect(shrunkAvgValue({ valueSum: 500, valueCount: 5 }, 0)).toBe(100);
    expect(shrunkAvgValue({ valueSum: 0, valueCount: 0 }, 0)).toBe(0);
  });
  it('exports the shrink constant aligned with MIN_VALUED_CONVERSIONS', () => {
    expect(EV_SHRINK_K).toBe(20);
  });
});

describe('sampleArmEv', () => {
  const seeded = (vals: number[]) => { let i = 0; return () => vals[i++ % vals.length]!; };

  it('with no value data anywhere, picks exactly what CVR Thompson would pick', () => {
    const rand = seeded([0.3, 0.7, 0.6, 0.2, 0.9, 0.1, 0.4, 0.8]);
    const rand2 = seeded([0.3, 0.7, 0.6, 0.2, 0.9, 0.1, 0.4, 0.8]);
    const arms = [
      { arm: 'a', alpha: 5, beta: 5, valueSum: 0, valueCount: 0 },
      { arm: 'b', alpha: 8, beta: 2, valueSum: 0, valueCount: 0 },
    ];
    expect(sampleArmEv(arms, 100, rand)).toBe(sampleArm(arms, rand2));
  });

  it('a lower-CVR arm with much higher order values can win', () => {
    // Deterministic rand → posterior draws are fixed; give arm b a huge avg value.
    const rand = () => 0.5;
    const arms = [
      { arm: 'a', alpha: 50, beta: 50, valueSum: 100 * 50, valueCount: 50 },   // avg 100
      { arm: 'b', alpha: 40, beta: 60, valueSum: 400 * 40, valueCount: 40 },   // avg 400
    ];
    expect(sampleArmEv(arms, 100, rand)).toBe('b');
  });

  it('returns null on no arms and the only arm otherwise', () => {
    expect(sampleArmEv([], 100)).toBeNull();
    expect(sampleArmEv([{ arm: 'only', alpha: 1, beta: 1, valueSum: 0, valueCount: 0 }], 100)).toBe('only');
  });

  // Audit I10, EV path: a corrupt posterior is excluded before scoring, so even
  // a huge value multiplier cannot carry it.
  it('never serves an arm with a corrupt posterior, whatever its value', () => {
    let s = 3;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
    for (const [a, b] of [[NaN, 5], [0, 0], [-0.5, 2], [Infinity, 1]] as const) {
      const arms = [
        { arm: 'corrupt', alpha: a, beta: b, valueSum: 1e6 * 50, valueCount: 50 },
        { arm: 'x', alpha: 5, beta: 95, valueSum: 0, valueCount: 0 },
        { arm: 'y', alpha: 6, beta: 94, valueSum: 0, valueCount: 0 },
      ];
      for (let i = 0; i < 300; i++) expect(sampleArmEv(arms, 100, rand)).not.toBe('corrupt');
    }
  });

  it('draws from Beta(1,1) on every arm when all are corrupt (no crash, no capture)', () => {
    let s = 9;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
    const arms = [
      { arm: 'a', alpha: NaN, beta: 1, valueSum: 0, valueCount: 0 },
      { arm: 'b', alpha: 0, beta: 0, valueSum: 0, valueCount: 0 },
    ];
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(sampleArmEv(arms, 100, rand)!);
    expect(seen).toEqual(new Set(['a', 'b']));
  });

  // A non-finite value multiplier is excluded by the posterior guard's rule
  // (CONTRACTS §3). Before, an all-NaN set left the argmax with no best arm and
  // `best!.arm` threw a TypeError on the decide path; a +Infinity arm won
  // every draw.
  describe('non-finite value multipliers', () => {
    const lcg = (seed: number) => { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; }; };

    it('does not crash when every multiplier is NaN, and draws plain CVR Thompson', () => {
      const arms = [
        { arm: 'a', alpha: 5, beta: 95, valueSum: NaN, valueCount: 3 },
        { arm: 'b', alpha: 40, beta: 60, valueSum: NaN, valueCount: 3 },
      ];
      const r1 = lcg(11);
      const r2 = lcg(11);
      for (let i = 0; i < 200; i++) expect(sampleArmEv(arms, 100, r1)).toBe(sampleArm(arms, r2));
    });

    it('does not crash on a NaN reference (every multiplier NaN through the shrink)', () => {
      const arms = [
        { arm: 'a', alpha: 5, beta: 5, valueSum: 100, valueCount: 1 },
        { arm: 'b', alpha: 5, beta: 5, valueSum: 200, valueCount: 1 },
      ];
      expect(['a', 'b']).toContain(sampleArmEv(arms, NaN, lcg(2)));
    });

    it.each([NaN, Infinity, -Infinity])('never serves an arm whose multiplier is %s', (bad) => {
      const rand = lcg(5);
      const arms = [
        { arm: 'bad', alpha: 50, beta: 50, valueSum: bad, valueCount: 1 },
        { arm: 'x', alpha: 5, beta: 95, valueSum: 0, valueCount: 0 },
        { arm: 'y', alpha: 6, beta: 94, valueSum: 0, valueCount: 0 },
      ];
      for (let i = 0; i < 300; i++) expect(sampleArmEv(arms, 100, rand)).not.toBe('bad');
    });

    it('a lone finite multiplier is served undrawn', () => {
      const arms = [
        { arm: 'bad', alpha: 90, beta: 10, valueSum: NaN, valueCount: 1 },
        { arm: 'ok', alpha: 1, beta: 99, valueSum: 0, valueCount: 0 },
      ];
      let calls = 0;
      const rand = () => { calls++; return 0.5; };
      expect(sampleArmEv(arms, 100, rand)).toBe('ok');
      expect(calls).toBe(0);
    });

    it('with finite multipliers the draw is unchanged: same pick as scoring every arm', () => {
      const arms = [
        { arm: 'a', alpha: 30, beta: 70, valueSum: 300, valueCount: 3 },
        { arm: 'b', alpha: 40, beta: 60, valueSum: 0, valueCount: 0 },
        { arm: 'c', alpha: 35, beta: 65, valueSum: -50, valueCount: 1 },
      ];
      // Reference implementation of the pre-guard loop (valid inputs only).
      const naive = (rand: () => number) => {
        let best = arms[0]!;
        let bestScore = -Infinity;
        for (const a of arms) {
          const s = sampleBeta(a.alpha, a.beta, rand) * shrunkAvgValue(a, 100);
          if (s > bestScore) { best = a; bestScore = s; }
        }
        return best.arm;
      };
      const r1 = lcg(17);
      const r2 = lcg(17);
      for (let i = 0; i < 200; i++) expect(sampleArmEv(arms, 100, r1)).toBe(naive(r2));
    });

    it('usableMultipliers: keeps finite ones (≤ 0 included), all non-finite → 1 everywhere', () => {
      expect(usableMultipliers([1, NaN, 0, -2, Infinity])).toEqual({ index: [0, 2, 3], mults: [1, 0, -2] });
      expect(usableMultipliers([NaN, -Infinity])).toEqual({ index: [0, 1], mults: [1, 1] });
      expect(usableMultipliers([])).toEqual({ index: [], mults: [] });
    });
  });
});
