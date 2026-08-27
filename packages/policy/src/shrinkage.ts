/**
 * Empirical-Bayes pooling strength, in pseudo-observations. A cell is born
 * holding `m` imaginary trials drawn at its parent's rate, and its own data
 * outvotes them once it has collected more than `m` real ones.
 */
export const SHRINKAGE_M = 20;

/**
 * Empirical-Bayes shrinkage toward a parent posterior, at read time.
 * Pinned in CONTRACTS.md §4.
 *
 * A cell is born warm — with no data of its own it sits at the parent's rate —
 * and detaches as its own evidence accumulates.
 *
 *   mu       = pooled.alpha / (pooled.alpha + pooled.beta)   // parent's rate
 *   strength = m * mass / (mass + m),  mass = pooled.alpha + pooled.beta
 *   alpha'   = cell.alpha + strength * mu
 *   beta'    = cell.beta  + strength * (1 - mu)
 *
 * The prior contributes a FIXED number of pseudo-observations, never a copy of
 * the parent's counts. That distinction is the whole point of this function.
 * The previous form was `cell.alpha + w * pooled.alpha` with
 * `w = m / (m + cell.exposures)`, which folded the parent's SAMPLE SIZE into
 * the child, and broke in two compounding ways once a project had real traffic:
 *
 *  - Because the write path expands every trial into the child, both marginals
 *    and the global row (`weightCellsFor`), the parent's counts grow with total
 *    project volume. A cell then needed roughly sqrt(m * N_parent) exposures
 *    before its own rate mattered — ~1,400 against a 100k-exposure parent, not
 *    the ~20 the constant advertises. Personalization effectively never arrived.
 *  - Worse, the child inherited the parent's CONFIDENCE along with its rate. A
 *    20-exposure cell emerged with a posterior of pseudo-count ~8,400 and a
 *    standard deviation of 0.002 against the ~0.09 its evidence justifies.
 *    Thompson Sampling draws from that posterior are effectively deterministic,
 *    so exploration collapsed exactly in the thin cells that needed it.
 *
 * `strength` is itself damped by the parent's mass so a parent that has barely
 * any data of its own cannot inject `m` confident pseudo-observations of a rate
 * nobody knows yet: an empty parent (mass 2, the flat Beta(1,1)) contributes
 * ~1.8 pseudo-trials, a well-sampled one contributes the full `m`.
 */
export function shrunkPosterior(
  cell: { alpha: number; beta: number },
  pooled: { alpha: number; beta: number },
  m: number = SHRINKAGE_M,
): { alpha: number; beta: number } {
  const mass = pooled.alpha + pooled.beta;
  if (mass <= 0 || m <= 0) return { alpha: cell.alpha, beta: cell.beta };
  const mu = pooled.alpha / mass;
  const strength = (m * mass) / (mass + m);
  return { alpha: cell.alpha + strength * mu, beta: cell.beta + strength * (1 - mu) };
}
