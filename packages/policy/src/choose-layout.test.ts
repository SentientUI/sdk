import { describe, expect, it } from 'vitest';
import { applyClusterHeuristic, candidateLayouts } from './layout-heuristics';
import { hashLayout } from './hash';
import { chooseLayout, type LearnedLayout } from './choose-layout';

const SECTIONS = ['hero', 'features', 'pricing', 'comparison'];
const TYPES = new Map([
  ['hero', 'hero'],
  ['features', 'features'],
  ['pricing', 'pricing'],
  ['comparison', 'comparison'],
]);

describe('chooseLayout', () => {
  it('returns a valid candidate at cold start (no learned rows)', () => {
    const learned = new Map<string, LearnedLayout>();
    const order = chooseLayout(SECTIONS, TYPES, 'buyer', learned, () => 0.5);
    const candidates = [...candidateLayouts(SECTIONS, TYPES, 'buyer').values()];
    expect(candidates).toContainEqual(order);
  });

  it('serves the learned high-reward ordering over the persona default', () => {
    const researcherOrder = applyClusterHeuristic(SECTIONS, TYPES, 'researcher');
    const buyerOrder = applyClusterHeuristic(SECTIONS, TYPES, 'buyer');
    expect(researcherOrder).not.toEqual(buyerOrder);

    const learned = new Map<string, LearnedLayout>([
      [hashLayout(researcherOrder), { layoutHash: hashLayout(researcherOrder), alpha: 500, beta: 1 }],
    ]);
    // Beta(500,1) dominates every uniform Beta(1,1) arm.
    const order = chooseLayout(SECTIONS, TYPES, 'buyer', learned, () => 0.999);
    expect(order).toEqual(researcherOrder);
  });

  it('only ever returns a valid candidate ordering', () => {
    const learned = new Map<string, LearnedLayout>();
    const candidates = [...candidateLayouts(SECTIONS, TYPES, 'deal_seeker').values()];
    for (let i = 0; i < 20; i++) {
      expect(candidates).toContainEqual(chooseLayout(SECTIONS, TYPES, 'deal_seeker', learned, Math.random));
    }
  });

  it('works for the unknown persona (explores all heuristic orders + identity)', () => {
    const learned = new Map<string, LearnedLayout>();
    const candidates = [...candidateLayouts(SECTIONS, TYPES, 'unknown').values()];
    expect(candidates).toContainEqual(chooseLayout(SECTIONS, TYPES, 'unknown', learned, () => 0.5));
  });
});
