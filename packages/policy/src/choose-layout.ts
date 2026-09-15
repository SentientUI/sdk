import { candidateLayouts } from './layout-heuristics';
import { hashLayout } from './hash';
import { sampleArm, type ArmPosterior } from './bandit';
import type { SectionRole } from './taxonomy';

/** Learned Beta(alpha,beta) posterior for one candidate layout, keyed by hash. */
export type LearnedLayout = { layoutHash: string; alpha: number; beta: number };

/**
 * Thompson-samples the layout order to serve a persona over the candidate
 * orderings, using learned posteriors from layout_weights. Candidates with no
 * learned row use the uniform 1/1 prior — identical to variant cold start.
 *
 * The candidate set always contains the AUTHORED order, so "leave this page
 * alone" is a real arm that can win, and at cold start it is exactly as likely
 * as any reorder. This used to fall back to the persona's heuristic when
 * sampling yielded nothing — which could not happen (candidateLayouts is never
 * empty) and would have been the wrong answer anyway: with nothing to choose
 * on, the page the customer built is the only defensible thing to serve.
 *
 * `persona` no longer selects candidates — the orderings a page COULD be shown
 * in are a property of the page. It stays in the signature because it is what
 * the CALLER keyed `learned` by, which is where the persona belongs.
 *
 * @param rand Uniform [0,1) source. Defaults to `Math.random`, which is
 *   NON-DETERMINISTIC. Pass a seeded PRNG when you need a reproducible layout
 *   (tests, replayable decisions) — otherwise the sampled order varies per call.
 * @param sectionRoles Optional role map (phase 2d): structural sections are
 *   pinned in place across every candidate; see `orderByArchetype`.
 */
export function chooseLayout(
  sections: string[],
  sectionTypes: Map<string, string>,
  _persona: string,
  learned: Map<string, LearnedLayout>,
  rand: () => number = Math.random,
  sectionRoles?: Map<string, SectionRole>,
): string[] {
  return chooseLayoutDetailed(sections, sectionTypes, _persona, learned, rand, sectionRoles).order;
}

/** What `chooseLayoutDetailed` drew, and what it drew it from. */
export type LayoutChoice = {
  /** The served ordering (the authored order when nothing could be chosen). */
  order: string[];
  /** Hash of `order` — the arm id in `layout_weights` / `candidate_layouts`. */
  chosenHash: string;
  /** Every candidate hash the draw ran over, in candidate order. */
  candidates: string[];
  /** The posteriors the draw ran over, parallel to `candidates`. Provenance
   *  (migration 157) is computed from THESE, in the same call, because they
   *  move on every close-out pass and cannot be recovered afterwards. */
  arms: ArmPosterior[];
};

/**
 * `chooseLayout` plus the draw's provenance. Byte-identical selection — this
 * is the same function with its inputs returned alongside the output, so the
 * propensity a caller computes from `arms` describes the draw that produced
 * `order` and nothing else. The propensity itself is not computed here: the
 * deterministic quadrature lives in the API (`lib/beta.ts`
 * `armSelectionProbabilities`), where the slot path already uses it.
 */
export function chooseLayoutDetailed(
  sections: string[],
  sectionTypes: Map<string, string>,
  _persona: string,
  learned: Map<string, LearnedLayout>,
  rand: () => number = Math.random,
  sectionRoles?: Map<string, SectionRole>,
): LayoutChoice {
  const candidates = candidateLayouts(sections, sectionTypes, sectionRoles);
  const arms: ArmPosterior[] = [];
  for (const hash of candidates.keys()) {
    const w = learned.get(hash);
    arms.push({ arm: hash, alpha: w?.alpha ?? 1.0, beta: w?.beta ?? 1.0 });
  }
  const chosen = sampleArm(arms, rand);
  const winner = chosen ? candidates.get(chosen) : undefined;
  if (chosen && winner) {
    return { order: winner, chosenHash: chosen, candidates: arms.map((a) => a.arm), arms };
  }
  // Unreachable in practice (candidateLayouts always contains the authored
  // order), but the fallback must still describe itself honestly.
  return { order: sections, chosenHash: hashLayout(sections), candidates: arms.map((a) => a.arm), arms };
}
