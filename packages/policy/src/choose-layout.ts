import type { PersonaKey } from './personas';
import { applyClusterHeuristic, candidateLayouts } from './layout-heuristics';
import { sampleArm, type ArmPosterior } from './bandit';

/** Learned Beta(alpha,beta) posterior for one candidate layout, keyed by hash. */
export type LearnedLayout = { layoutHash: string; alpha: number; beta: number };

/**
 * Thompson-samples the layout order to serve a persona over the candidate
 * orderings, using learned posteriors from layout_weights. Candidates with no
 * learned row use the uniform 1/1 prior — identical to variant cold start.
 * Falls back to the persona's heuristic only if sampling yields no candidate.
 *
 * @param rand Uniform [0,1) source. Defaults to `Math.random`, which is
 *   NON-DETERMINISTIC. Pass a seeded PRNG when you need a reproducible layout
 *   (tests, replayable decisions) — otherwise the sampled order varies per call.
 */
export function chooseLayout(
  sections: string[],
  sectionTypes: Map<string, string>,
  persona: PersonaKey,
  learned: Map<string, LearnedLayout>,
  rand: () => number = Math.random,
): string[] {
  const candidates = candidateLayouts(sections, sectionTypes, persona);
  const arms: ArmPosterior[] = [];
  for (const hash of candidates.keys()) {
    const w = learned.get(hash);
    arms.push({ arm: hash, alpha: w?.alpha ?? 1.0, beta: w?.beta ?? 1.0 });
  }
  const chosen = sampleArm(arms, rand);
  const winner = chosen ? candidates.get(chosen) : undefined;
  return winner ?? applyClusterHeuristic(sections, sectionTypes, persona);
}
