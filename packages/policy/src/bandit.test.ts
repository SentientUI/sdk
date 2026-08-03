import { describe, expect, it } from 'vitest';
import { sampleBeta, sampleArm, type ArmPosterior } from './bandit';

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
