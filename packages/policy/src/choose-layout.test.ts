import { describe, expect, it } from 'vitest';
import { orderByArchetype, candidateLayouts } from './layout-heuristics';
import { hashLayout } from './hash';
import { chooseLayout, chooseLayoutDetailed, type LearnedLayout } from './choose-layout';

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
    const order = chooseLayout(SECTIONS, TYPES, 'admin', learned, () => 0.5);
    const candidates = [...candidateLayouts(SECTIONS, TYPES).values()];
    expect(candidates).toContainEqual(order);
  });

  it('serves the learned high-reward ordering over the persona default', () => {
    const evidenceOrder = orderByArchetype(SECTIONS, TYPES, 'evidence_led');
    const conversionOrder = orderByArchetype(SECTIONS, TYPES, 'conversion_led');
    expect(evidenceOrder).not.toEqual(conversionOrder);

    const learned = new Map<string, LearnedLayout>([
      [hashLayout(evidenceOrder), { layoutHash: hashLayout(evidenceOrder), alpha: 500, beta: 1 }],
    ]);
    // Beta(500,1) dominates every uniform Beta(1,1) arm.
    const order = chooseLayout(SECTIONS, TYPES, 'admin', learned, () => 0.999);
    expect(order).toEqual(evidenceOrder);
  });

  it('only ever returns a valid candidate ordering', () => {
    const learned = new Map<string, LearnedLayout>();
    const candidates = [...candidateLayouts(SECTIONS, TYPES).values()];
    for (let i = 0; i < 20; i++) {
      expect(candidates).toContainEqual(chooseLayout(SECTIONS, TYPES, 'evaluator', learned, Math.random));
    }
  });

  it('works for the unknown persona (explores all archetype orders + the authored one)', () => {
    const learned = new Map<string, LearnedLayout>();
    const candidates = [...candidateLayouts(SECTIONS, TYPES).values()];
    expect(candidates).toContainEqual(chooseLayout(SECTIONS, TYPES, 'unknown', learned, () => 0.5));
  });

  it('CAN serve the authored order back — "leave the page alone" is a real arm', () => {
    // The guarantee added 2026-09-13. A page whose authored order matches no
    // archetype used to be unreachable for a persona named after one, so the
    // bandit was obliged to reorder no matter what the evidence said.
    const authored = ['social_proof', 'pricing', 'faq', 'hero'];
    const t = new Map([
      ['social_proof', 'social_proof'],
      ['pricing', 'pricing'],
      ['faq', 'faq'],
      ['hero', 'hero'],
    ]);
    const learned = new Map<string, LearnedLayout>([
      [hashLayout(authored), { layoutHash: hashLayout(authored), alpha: 500, beta: 1 }],
    ]);
    expect(chooseLayout(authored, t, 'admin', learned, () => 0.999)).toEqual(authored);
  });

  it('serves the authored order when there is nothing to choose on', () => {
    // Degenerate input: no candidate can be sampled. The old code fell back to
    // the persona's archetype — a reorder chosen by a constant table at exactly
    // the moment the engine knows least.
    expect(chooseLayout([], new Map(), 'admin', new Map(), () => 0.5)).toEqual([]);
  });
});

describe('chooseLayoutDetailed (decision provenance, migration 157)', () => {
  it('returns the same order chooseLayout would for the same draw, plus what it drew from', () => {
    const learned = new Map<string, LearnedLayout>();
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let seed2 = 42;
    const rand2 = () => ((seed2 = (seed2 * 1103515245 + 12345) % 2147483648) / 2147483648);
    const plain = chooseLayout(SECTIONS, TYPES, 'admin', learned, rand);
    const detailed = chooseLayoutDetailed(SECTIONS, TYPES, 'admin', learned, rand2);
    expect(detailed.order).toEqual(plain);
    expect(detailed.chosenHash).toBe(hashLayout(plain));
    // Candidate set == every candidate ordering, authored order included.
    const expected = [...candidateLayouts(SECTIONS, TYPES).keys()];
    expect(detailed.candidates).toEqual(expected);
    expect(detailed.candidates).toContain(hashLayout(SECTIONS));
    // Posteriors parallel to the candidates: cold start is the uniform prior.
    expect(detailed.arms.map((a) => a.arm)).toEqual(expected);
    expect(detailed.arms.every((a) => a.alpha === 1 && a.beta === 1)).toBe(true);
  });

  it('carries the learned posterior the draw actually used', () => {
    const target = orderByArchetype(SECTIONS, TYPES, 'pricing_first' as never) ?? SECTIONS;
    const hash = hashLayout(target);
    const learned = new Map<string, LearnedLayout>([[hash, { layoutHash: hash, alpha: 50, beta: 2 }]]);
    const d = chooseLayoutDetailed(SECTIONS, TYPES, 'admin', learned, () => 0.5);
    const arm = d.arms.find((a) => a.arm === hash);
    expect(arm).toEqual({ arm: hash, alpha: 50, beta: 2 });
  });
});
