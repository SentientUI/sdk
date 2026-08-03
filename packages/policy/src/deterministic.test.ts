import { describe, expect, it } from 'vitest';
import { fnv1a, pickDeterministicArm, confidenceBand } from './deterministic';

describe('fnv1a', () => {
  it('matches the apps/api holdout.ts algorithm on fixture vectors', () => {
    // Computed with the exact loop from apps/api/src/domain/holdout.ts.
    expect(fnv1a('')).toBe(2166136261); // FNV-1a 32-bit offset basis
    expect(fnv1a('a')).toBe(3826002220);
    expect(fnv1a('abc')).toBe(440920331);
    expect(fnv1a('sess-1:hero')).toBe(1623028549);
    expect(fnv1a('sess-2:hero')).toBe(2388310694);
    expect(fnv1a('sess-1:cta')).toBe(2099722837);
  });

  it('always returns an unsigned 32-bit integer', () => {
    for (const s of ['', 'x', 'a-much-longer-session-identifier-0123456789']) {
      const h = fnv1a(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(0x100000000);
    }
  });
});

describe('pickDeterministicArm', () => {
  it('picks fnv1a(`session:slot`) % arms.length over the sorted arms', () => {
    // fnv1a('sess-1:hero') = 1623028549 → % 3 = 1 → sorted ['a','b','c'][1]
    expect(pickDeterministicArm('sess-1', 'hero', ['a', 'b', 'c'])).toBe('b');
    // fnv1a('sess-2:hero') = 2388310694 → % 3 = 2 → 'c'
    expect(pickDeterministicArm('sess-2', 'hero', ['a', 'b', 'c'])).toBe('c');
    // fnv1a('sess-1:cta') = 2099722837 → % 3 = 1 → 'b'
    expect(pickDeterministicArm('sess-1', 'cta', ['a', 'b', 'c'])).toBe('b');
  });

  it('is insensitive to the declaration order of arms', () => {
    expect(pickDeterministicArm('sess-1', 'hero', ['c', 'a', 'b'])).toBe('b');
  });

  it('does not mutate the input array', () => {
    const arms = ['c', 'a', 'b'];
    pickDeterministicArm('sess-1', 'hero', arms);
    expect(arms).toEqual(['c', 'a', 'b']);
  });

  it('returns the sole arm and throws on an empty arm list', () => {
    expect(pickDeterministicArm('sess-1', 'hero', ['only'])).toBe('only');
    expect(() => pickDeterministicArm('sess-1', 'hero', [])).toThrow();
  });
});

describe('confidenceBand', () => {
  it('buckets per the pinned thresholds', () => {
    expect(confidenceBand(0)).toBe('low');
    expect(confidenceBand(0.29)).toBe('low');
    expect(confidenceBand(0.3)).toBe('medium');
    expect(confidenceBand(0.69)).toBe('medium');
    expect(confidenceBand(0.7)).toBe('high');
    expect(confidenceBand(1)).toBe('high');
  });

  it('treats NaN as low, never high', () => {
    expect(confidenceBand(Number.NaN)).toBe('low');
  });
});
