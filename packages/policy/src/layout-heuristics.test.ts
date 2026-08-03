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
});
