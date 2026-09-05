import { describe, expect, it } from 'vitest';
import { PERSONAS } from './personas';
import { CLUSTER_PRIORITY, applyClusterHeuristic, candidateLayouts } from './layout-heuristics';
import { hashLayout } from './hash';

describe('CLUSTER_PRIORITY', () => {
  it('is keyed by exactly the canonical personas (singular/underscore)', () => {
    expect(Object.keys(CLUSTER_PRIORITY).sort()).toEqual([...PERSONAS].sort());
  });
});

describe('applyClusterHeuristic', () => {
  const sections = ['hero', 'features', 'pricing'];
  const types = new Map([
    ['hero', 'hero'],
    ['features', 'features'],
    ['pricing', 'pricing'],
  ]);

  it('returns the input order unchanged for unknown', () => {
    expect(applyClusterHeuristic(sections, types, 'unknown')).toEqual(['hero', 'features', 'pricing']);
  });

  it('puts pricing first for buyer', () => {
    expect(applyClusterHeuristic(sections, types, 'buyer')[0]).toBe('pricing');
  });

  it('puts features first for researcher', () => {
    const result = applyClusterHeuristic(['pricing', 'hero', 'features'], types, 'researcher');
    expect(result[0]).toBe('features');
  });

  it('treats sections with no graph entry as generic', () => {
    const thin = new Map([
      ['hero', 'hero'],
      ['pricing', 'pricing'],
    ]);
    const result = applyClusterHeuristic(['hero', 'mystery', 'pricing'], thin, 'buyer');
    expect(result).toContain('mystery');
    expect(result).toHaveLength(3);
  });

  it('does not mutate the input array', () => {
    const input = ['hero', 'features', 'pricing'];
    applyClusterHeuristic(input, types, 'buyer');
    expect(input).toEqual(['hero', 'features', 'pricing']);
  });

  it('pins structural sections at their original index (phase 2d)', () => {
    // 'navigation' ranks near LAST in every persona priority, so without the
    // pin the navbar would sort to the bottom of the page — the visible damage
    // the role projection exists to prevent.
    const secs = ['nav', 'hero', 'pricing', 'footer'];
    const t = new Map([
      ['nav', 'navigation'],
      ['hero', 'hero'],
      ['pricing', 'pricing'],
      ['footer', 'navigation'],
    ]);
    const roles = new Map<string, 'converter' | 'persuader' | 'structural'>([
      ['nav', 'structural'],
      ['hero', 'converter'],
      ['pricing', 'converter'],
      ['footer', 'structural'],
    ]);
    const result = applyClusterHeuristic(secs, t, 'buyer', roles);
    expect(result[0]).toBe('nav');
    expect(result[3]).toBe('footer');
    // buyer ranks pricing before hero among the movable sections.
    expect(result).toEqual(['nav', 'pricing', 'hero', 'footer']);
  });

  it('with a roles map but no structural sections matches the role-less order', () => {
    const roles = new Map<string, 'converter' | 'persuader' | 'structural'>([
      ['hero', 'converter'],
      ['features', 'persuader'],
      ['pricing', 'converter'],
    ]);
    expect(applyClusterHeuristic(sections, types, 'buyer', roles)).toEqual(
      applyClusterHeuristic(sections, types, 'buyer'),
    );
  });

  it('returns the input unchanged for unknown persona even with roles', () => {
    const roles = new Map<string, 'converter' | 'persuader' | 'structural'>([['hero', 'structural']]);
    expect(applyClusterHeuristic(sections, types, 'unknown', roles)).toEqual(sections);
  });

  it('sorts a present-but-off-vocabulary type LAST, not first (no top-of-page hijack)', () => {
    // 'newsletter' is not in any persona priority list. It must fall to generic's
    // rank (last), never indexOf===-1 which would sort it ahead of pricing.
    const withOffVocab = new Map([
      ['newsletter', 'newsletter'],
      ['hero', 'hero'],
      ['pricing', 'pricing'],
    ]);
    const result = applyClusterHeuristic(['newsletter', 'hero', 'pricing'], withOffVocab, 'buyer');
    // buyer ranks pricing first; the unknown 'newsletter' section must be last by POSITION.
    expect(result[0]).toBe('pricing');
    expect(result[result.length - 1]).toBe('newsletter');
  });
});

const SECTIONS = ['hero', 'features', 'pricing', 'comparison'];
const TYPES = new Map([
  ['hero', 'hero'],
  ['features', 'features'],
  ['pricing', 'pricing'],
  ['comparison', 'comparison'],
]);

describe('candidateLayouts', () => {
  it('includes every distinct persona ordering as a candidate arm', () => {
    expect(candidateLayouts(SECTIONS, TYPES, 'buyer').size).toBeGreaterThan(1);
  });

  it('keys candidates by the same hash the worker credits', () => {
    for (const [hash, order] of candidateLayouts(SECTIONS, TYPES, 'buyer')) {
      expect(hash).toBe(hashLayout(order));
    }
  });

  it('always contains the persona own heuristic ordering', () => {
    const candidates = candidateLayouts(SECTIONS, TYPES, 'buyer');
    expect([...candidates.values()]).toContainEqual(applyClusterHeuristic(SECTIONS, TYPES, 'buyer'));
  });

  it('includes the identity order as a candidate for unknown persona', () => {
    const candidates = candidateLayouts(SECTIONS, TYPES, 'unknown');
    expect([...candidates.values()]).toContainEqual(SECTIONS);
  });

  it('pins structural sections across EVERY candidate (phase 2d)', () => {
    const secs = ['nav', ...SECTIONS, 'footer'];
    const t = new Map([...TYPES, ['nav', 'navigation'], ['footer', 'navigation']]);
    const roles = new Map<string, 'converter' | 'persuader' | 'structural'>([
      ['nav', 'structural'],
      ['footer', 'structural'],
    ]);
    const candidates = candidateLayouts(secs, t, 'buyer', roles);
    expect(candidates.size).toBeGreaterThan(1);
    for (const order of candidates.values()) {
      expect(order[0]).toBe('nav');
      expect(order[order.length - 1]).toBe('footer');
    }
  });
});
