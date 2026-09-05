import { sampleBeta } from './bandit';
import { posteriorOfCounts } from './pooling';
import { shrunkPosterior } from './shrinkage';
import { applyClusterHeuristic, candidateLayouts } from './layout-heuristics';
import type { SectionRole } from './taxonomy';

/**
 * Factored layout value model (spec 2026-09-04 §3a).
 *
 * `layout_weights` gives every distinct order an independent Beta posterior
 * sharing NOTHING with an order that differs by one swap — so more candidate
 * diversity (exactly what the semantic work creates) splits the same thin
 * traffic across more independent posteriors and convergence gets worse, not
 * better. This model replaces one-parameter-per-permutation with
 *
 *   V(order | persona) = Σ_p  w[parent(section at p), bucket(p)]
 *                            + δ[persona, parent, bucket]
 *
 * 10 parents × 4 position buckets = 40 global parameters, so every trial
 * teaches every candidate that shares its structure: a conversion under order
 * A updates "pricing above the fold", which transfers to every order that also
 * puts pricing high. δ is the persona deviation, shrunk toward the global cell
 * by the same mean-only-crossing machinery variants use (CONTRACTS §4) —
 * a thin persona collapses to the global model instead of estimating noise.
 *
 * It improves sample efficiency; it does not manufacture signal. With a
 * handful of conversions no model learns a ranking — which is what the
 * feasibility gate exists to say out loud before this one runs.
 */

/** Position buckets: above-fold / early / mid / late. Coarse on purpose — the
 *  bucket count bounds the parameter space, and 4 is the pinned value. */
export const LAYOUT_FACTOR_BUCKETS = 4;

/** Persona key of the pooled global cells. Reserved — never a real persona. */
export const GLOBAL_FACTOR_PERSONA = '__global__';

/** Length-invariant bucket for a section's position in an order. */
export function layoutBucketOf(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(LAYOUT_FACTOR_BUCKETS - 1, Math.floor((index * LAYOUT_FACTOR_BUCKETS) / length));
}

export type LayoutFactorCell = {
  persona: string; // GLOBAL_FACTOR_PERSONA or a vocabulary persona key
  parent: string;
  bucket: number;
  exposures: number;
  conversions: number;
};

/** The (parent, bucket) cells one served order contributes to — the write-side
 *  projection close-out uses. Sections with no known type count as 'generic'. */
export function factorCellsForOrder(
  order: string[],
  sectionTypes: Map<string, string>,
): Array<{ parent: string; bucket: number }> {
  return order.map((id, i) => ({
    parent: sectionTypes.get(id) ?? 'generic',
    bucket: layoutBucketOf(i, order.length),
  }));
}

const cellKey = (parent: string, bucket: number): string => `${parent}#${bucket}`;

/**
 * Thompson-style selection over the factored model: ONE Beta draw per
 * (parent, bucket) cell — shared across every candidate, so candidates are
 * compared under the same sampled world (a fresh draw per candidate would add
 * pure comparison noise) — then argmax of the summed position values.
 *
 * Persona cells are consulted only when `persona` is known and shrink toward
 * the global cell (mean crosses, sample size never — CONTRACTS §4). Cold
 * start degrades gracefully: empty cells draw from Beta(1,1), which still
 * randomises across candidates, so exploration survives the switch.
 *
 * Falls back to the persona's heuristic prior when there are no candidates.
 */
export function chooseLayoutFactored(
  sections: string[],
  sectionTypes: Map<string, string>,
  persona: string,
  cells: LayoutFactorCell[],
  rand: () => number = Math.random,
  sectionRoles?: Map<string, SectionRole>,
): string[] {
  const candidates = candidateLayouts(sections, sectionTypes, persona, sectionRoles);
  if (candidates.size === 0) return applyClusterHeuristic(sections, sectionTypes, persona, sectionRoles);

  const global = new Map<string, LayoutFactorCell>();
  const perPersona = new Map<string, LayoutFactorCell>();
  // All-cells pool: the project's overall per-position conversion level. Every
  // global cell shrinks toward it (mean-only crossing, same §4 machinery), so
  // an UNOBSERVED cell draws near the pooled rate with damped confidence
  // instead of from a flat Beta(1,1). Without this, six unknown cells at
  // sd≈0.29 each drown the two cells that carry real signal — the sum's noise
  // scales with the number of positions, and the model would explore forever
  // on pages it has already learned.
  let poolExposures = 0;
  let poolConversions = 0;
  for (const c of cells) {
    if (c.persona === GLOBAL_FACTOR_PERSONA) {
      global.set(cellKey(c.parent, c.bucket), c);
      poolExposures += c.exposures;
      poolConversions += c.conversions;
    } else if (c.persona === persona) {
      perPersona.set(cellKey(c.parent, c.bucket), c);
    }
  }
  const poolPost = posteriorOfCounts({ exposures: poolExposures, conversions: poolConversions });

  const draws = new Map<string, number>();
  const drawFor = (parent: string, bucket: number): number => {
    const key = cellKey(parent, bucket);
    const cached = draws.get(key);
    if (cached !== undefined) return cached;
    const g = global.get(key);
    const gPost = shrunkPosterior(
      posteriorOfCounts({ exposures: g?.exposures ?? 0, conversions: g?.conversions ?? 0 }),
      poolPost,
    );
    const p = perPersona.get(key);
    const post = p
      ? shrunkPosterior(posteriorOfCounts({ exposures: p.exposures, conversions: p.conversions }), gPost)
      : gPost;
    const v = sampleBeta(post.alpha, post.beta, rand);
    draws.set(key, v);
    return v;
  };

  let best: string[] | null = null;
  let bestScore = -Infinity;
  for (const order of candidates.values()) {
    let score = 0;
    for (let i = 0; i < order.length; i++) {
      score += drawFor(sectionTypes.get(order[i]!) ?? 'generic', layoutBucketOf(i, order.length));
    }
    if (score > bestScore) {
      bestScore = score;
      best = order;
    }
  }
  return best ?? applyClusterHeuristic(sections, sectionTypes, persona, sectionRoles);
}
