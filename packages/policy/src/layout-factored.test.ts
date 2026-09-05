import { describe, expect, it } from 'vitest';
import {
  GLOBAL_FACTOR_PERSONA,
  LAYOUT_FACTOR_BUCKETS,
  chooseLayoutFactored,
  factorCellsForOrder,
  layoutBucketOf,
  type LayoutFactorCell,
} from './layout-factored';
import { candidateLayouts } from './layout-heuristics';

const seeded = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
};

const SECTIONS = ['hero', 'features', 'pricing', 'social', 'faq', 'cta', 'trust', 'generic1'];
const TYPES = new Map([
  ['hero', 'hero'],
  ['features', 'features'],
  ['pricing', 'pricing'],
  ['social', 'social_proof'],
  ['faq', 'faq'],
  ['cta', 'cta'],
  ['trust', 'trust'],
  ['generic1', 'generic'],
]);

const cell = (persona: string, parent: string, bucket: number, exposures: number, conversions: number): LayoutFactorCell =>
  ({ persona, parent, bucket, exposures, conversions });

describe('layoutBucketOf', () => {
  it('pins 4 buckets and is length-invariant', () => {
    expect(LAYOUT_FACTOR_BUCKETS).toBe(4);
    // 8 sections: pairs per bucket.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => layoutBucketOf(i, 8))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    // 4 sections: one each.
    expect([0, 1, 2, 3].map((i) => layoutBucketOf(i, 4))).toEqual([0, 1, 2, 3]);
    // Position 0 is always above-fold; the last position is always late (len > 1).
    expect(layoutBucketOf(0, 13)).toBe(0);
    expect(layoutBucketOf(12, 13)).toBe(3);
    expect(layoutBucketOf(0, 0)).toBe(0);
  });
});

describe('factorCellsForOrder', () => {
  it('projects an order onto (parent, bucket) cells, unknown type → generic', () => {
    expect(factorCellsForOrder(['a', 'b'], new Map([['a', 'hero']]))).toEqual([
      { parent: 'hero', bucket: 0 },
      { parent: 'generic', bucket: 2 },
    ]);
  });
});

describe('chooseLayoutFactored', () => {
  it('returns a candidate order (a permutation of the sections)', () => {
    const order = chooseLayoutFactored(SECTIONS, TYPES, 'buyer', [], seeded(1));
    expect([...order].sort()).toEqual([...SECTIONS].sort());
    const candidates = candidateLayouts(SECTIONS, TYPES, 'buyer');
    expect([...candidates.values()]).toContainEqual(order);
  });

  it('is reproducible under a seeded RNG', () => {
    const a = chooseLayoutFactored(SECTIONS, TYPES, 'buyer', [], seeded(42));
    const b = chooseLayoutFactored(SECTIONS, TYPES, 'buyer', [], seeded(42));
    expect(a).toEqual(b);
  });

  it('cold start still explores across candidates (not a constant pick)', () => {
    const picks = new Set<string>();
    for (let s = 0; s < 200; s++) picks.add(chooseLayoutFactored(SECTIONS, TYPES, 'buyer', [], seeded(s)).join(','));
    expect(picks.size).toBeGreaterThan(1);
  });

  /** A learned world: every (parent, bucket) cell observed at a 5% base rate,
   *  so candidate comparisons are driven by signal rather than by the flat
   *  priors of never-served cells. */
  const learnedWorld = (overrides: LayoutFactorCell[]): LayoutFactorCell[] => {
    const out: LayoutFactorCell[] = [];
    const overridden = new Set(overrides.map((o) => `${o.parent}#${o.bucket}`));
    for (const parent of ['hero', 'features', 'pricing', 'social_proof', 'faq', 'cta', 'trust', 'generic']) {
      for (let bucket = 0; bucket < LAYOUT_FACTOR_BUCKETS; bucket++) {
        if (!overridden.has(`${parent}#${bucket}`)) out.push(cell(GLOBAL_FACTOR_PERSONA, parent, bucket, 400, 20));
      }
    }
    return [...out, ...overrides];
  };

  it('a strong global "pricing above the fold" cell pulls pricing-first orders ahead', () => {
    // Evidence transfers across candidates: only the (pricing, bucket 0) cell
    // is exceptional, yet every order that puts pricing high benefits.
    const cells = learnedWorld([
      cell(GLOBAL_FACTOR_PERSONA, 'pricing', 0, 400, 80),
      cell(GLOBAL_FACTOR_PERSONA, 'hero', 0, 400, 8),
    ]);
    let pricingFirst = 0;
    const N = 300;
    for (let s = 0; s < N; s++) {
      const order = chooseLayoutFactored(SECTIONS, TYPES, 'buyer', cells, seeded(s));
      if (TYPES.get(order[0]!) === 'pricing') pricingFirst++;
    }
    expect(pricingFirst / N).toBeGreaterThan(0.8);
  });

  it('persona deviation shrinks toward the global cell — a thin persona cannot override it', () => {
    // Global says pricing-first converts; the persona cell disagrees on 3
    // exposures. Mean-only crossing (CONTRACTS §4) must keep the global view
    // dominant rather than letting 3 observations flip the layout.
    const cells = [
      ...learnedWorld([
        cell(GLOBAL_FACTOR_PERSONA, 'pricing', 0, 2000, 400),
        cell(GLOBAL_FACTOR_PERSONA, 'hero', 0, 2000, 40),
      ]),
      cell('buyer', 'pricing', 0, 3, 0),
    ];
    let pricingFirst = 0;
    const N = 300;
    for (let s = 0; s < N; s++) {
      const order = chooseLayoutFactored(SECTIONS, TYPES, 'buyer', cells, seeded(s));
      if (TYPES.get(order[0]!) === 'pricing') pricingFirst++;
    }
    expect(pricingFirst / N).toBeGreaterThan(0.6);
  });

  it('another persona\'s cells are never consulted', () => {
    const noise = [cell('deal_seeker', 'hero', 0, 10_000, 9_999)];
    const a = chooseLayoutFactored(SECTIONS, TYPES, 'buyer', [], seeded(7));
    const b = chooseLayoutFactored(SECTIONS, TYPES, 'buyer', noise, seeded(7));
    expect(b).toEqual(a);
  });

  it('pins structural sections across every choice when roles are given', () => {
    const secs = ['nav', ...SECTIONS, 'footer'];
    const t = new Map([...TYPES, ['nav', 'navigation'], ['footer', 'navigation']]);
    const roles = new Map<string, 'converter' | 'persuader' | 'structural'>([
      ['nav', 'structural'],
      ['footer', 'structural'],
    ]);
    for (let s = 0; s < 25; s++) {
      const order = chooseLayoutFactored(secs, t, 'buyer', [], seeded(s), roles);
      expect(order[0]).toBe('nav');
      expect(order[order.length - 1]).toBe('footer');
    }
  });
});
