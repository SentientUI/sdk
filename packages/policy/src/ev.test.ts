import { describe, expect, it } from 'vitest';
import { EV_SHRINK_K, sampleArmEv, shrunkAvgValue } from './ev';
import { sampleArm } from './bandit';

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
});
