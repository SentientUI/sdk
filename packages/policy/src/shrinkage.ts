/** Empirical-Bayes pooling strength: w = m / (m + exposures). */
export const SHRINKAGE_M = 20;

/**
 * Empirical-Bayes persona shrinkage at read time. Persona cells are born warm
 * (pooled posterior dominates at 0 exposures) and detach as their own data
 * accumulates. Formula pinned in CONTRACTS.md:
 *   w = m / (m + persona.exposures)
 *   alpha' = persona.alpha + w * pooled.alpha
 *   beta'  = persona.beta  + w * pooled.beta
 */
export function shrunkPosterior(
  persona: { alpha: number; beta: number; exposures: number },
  pooled: { alpha: number; beta: number },
  m: number = SHRINKAGE_M,
): { alpha: number; beta: number } {
  const w = m / (m + persona.exposures);
  return { alpha: persona.alpha + w * pooled.alpha, beta: persona.beta + w * pooled.beta };
}
