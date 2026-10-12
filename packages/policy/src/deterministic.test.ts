import { describe, expect, it } from 'vitest';
import { fnv1a, fmix32, holdoutUnit, pickDeterministicArm, confidenceBand } from './deterministic';

describe('fnv1a', () => {
  it('matches the pinned fixture vectors', () => {
    // Pinned: shipped SDKs compute it in the browser (local-engine arm pick,
    // no-code capture ids), so a change here splits old and new clients.
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

describe('fmix32', () => {
  it('is the murmur3 32-bit finalizer (reference vectors)', () => {
    expect(fmix32(0)).toBe(0);
    expect(fmix32(1)).toBe(0x514e28b7);
    expect(fmix32(fnv1a('a'))).toBe(444641715);
  });

  it('is a bijection on uint32 (10k distinct probes, no collision)', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) seen.add(fmix32(Math.imul(i, 2654435761) >>> 0));
    expect(seen.size).toBe(10_000);
  });
});

describe('holdoutUnit', () => {
  it('is fmix32(fnv1a(`${projectId}:${sessionId}`)) / 2^32', () => {
    expect(holdoutUnit('p1', 's1')).toBe(fmix32(fnv1a('p1:s1')) / 0x100000000);
    expect(holdoutUnit('p1', 's1')).toBe(1055545854 / 0x100000000);
  });

  it('stays in [0, 1)', () => {
    for (const id of ['', 'x', 'sess-abc-123', '00000000-0000-0000-0000-000000000000']) {
      const u = holdoutUnit('proj', id);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  // Audit I21: the unsalted bucket made two projects' holdouts identical for a
  // shared id. Sequential ids are the adversarial case — salted plain FNV-1a
  // still showed phi ≈ 0.11 on them; the finalizer is what brings it to noise.
  it('draws independently across projects, even on sequential ids', () => {
    const n = 40_000;
    const rate = 0.1;
    for (const [a, b] of [
      ['8d0f3c1e-0000-4000-8000-000000000001', '8d0f3c1e-0000-4000-8000-000000000002'],
      ['proj-a', 'proj-b'],
    ] as const) {
      let na = 0;
      let nb = 0;
      let both = 0;
      for (let i = 0; i < n; i++) {
        const x = holdoutUnit(a, `session-${i}`) < rate;
        const y = holdoutUnit(b, `session-${i}`) < rate;
        if (x) na++;
        if (y) nb++;
        if (x && y) both++;
      }
      const pa = na / n;
      const pb = nb / n;
      const phi = (both / n - pa * pb) / Math.sqrt(pa * (1 - pa) * pb * (1 - pb));
      // Null sd of phi is 1/sqrt(n) ≈ 0.005; the old unsalted bucket gives 1.
      expect(Math.abs(phi)).toBeLessThan(0.025);
      // Marginals stay on the configured rate (sd ≈ 0.0015).
      expect(Math.abs(pa - rate)).toBeLessThan(0.008);
      expect(Math.abs(pb - rate)).toBeLessThan(0.008);
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
