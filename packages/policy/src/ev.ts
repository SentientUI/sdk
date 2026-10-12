// Parallel value posterior (Shopify revenue spec §7): EV-ranked serving as
// thompsonDraw(alpha, beta) × EB-shrunk average order value. With no value
// data the shrunk average IS the reference — a constant factor — so EV
// ranking degrades exactly to CVR ranking. Rollout-gated per project
// (ev_serving), never plan-gated.
import { sampleBeta, usablePosteriors, type ArmPosterior } from './bandit';

/** = MIN_VALUED_CONVERSIONS: cells earn their own voice at ~20 valued orders. */
export const EV_SHRINK_K = 20;

export type ValueCell = { valueSum: number; valueCount: number };

export function shrunkAvgValue(cell: ValueCell, reference: number, k: number = EV_SHRINK_K): number {
  const avg = cell.valueCount > 0 ? cell.valueSum / cell.valueCount : 0;
  if (reference <= 0) return avg;
  if (cell.valueCount <= 0) return reference;
  const w = cell.valueCount / (cell.valueCount + k);
  return w * avg + (1 - w) * reference;
}

export type EvArm = ArmPosterior & ValueCell;

/**
 * The arms whose value multiplier an EV draw can rank on — the multiplier
 * counterpart of `usablePosteriors` (CONTRACTS §3), applied AFTER it.
 *
 * A non-finite multiplier (NaN, ±Infinity) is EXCLUDED: probability 0. It
 * comes only from corrupt value state — a NaN `value_sum`, a NaN or infinite
 * reference — and `θ × NaN` is NaN, which no argmax can pick. Before this
 * guard an all-NaN set left `sampleArmEv` with no best arm and it dereferenced
 * null: the decide path threw instead of serving. A finite multiplier ≤ 0 is
 * NOT corrupt (a 0 reference with no value data, a negative average) and is
 * ranked as before.
 *
 * When EVERY multiplier is non-finite there is no value information left, and
 * the draw falls back to multiplier 1 on every arm — i.e. plain CVR Thompson
 * over the (usable) posteriors. That is the documented no-value-data
 * behaviour of EV serving (a constant factor), and it is what the posteriors,
 * which are still sound, support; a uniform pick would throw that away. Not a
 * reset of the corrupt multipliers either: a mixed set excludes them, so a
 * NaN arm cannot capture the traffic with a fabricated value.
 *
 * `index[k]` is the input position of the k-th kept arm, so a propensity
 * vector over the kept arms scatters back (zeros for the excluded).
 */
export function usableMultipliers(mults: readonly number[]): { index: number[]; mults: number[] } {
  const index: number[] = [];
  mults.forEach((m, i) => {
    if (Number.isFinite(m)) index.push(i);
  });
  if (index.length === 0) return { index: mults.map((_, i) => i), mults: mults.map(() => 1) };
  return { index, mults: index.map((i) => mults[i]!) };
}

/**
 * EV-ranked Thompson draw. Corrupt posteriors are excluded exactly as in
 * sampleArm (usablePosteriors — see there for why exclusion and not a reset to
 * the prior), then corrupt (non-finite) value multipliers by the same rule
 * (usableMultipliers); the API's evArmSelectionProbabilities applies both so
 * the logged odds describe this draw.
 */
export function sampleArmEv(arms: EvArm[], reference: number, rand: () => number = Math.random): string | null {
  if (arms.length === 0) return null;
  if (arms.length === 1) return arms[0]!.arm;
  const usable = usablePosteriors(arms).arms;
  if (usable.length === 1) return usable[0]!.arm;
  const kept = usableMultipliers(usable.map((a) => shrunkAvgValue(a, reference)));
  if (kept.index.length === 1) return usable[kept.index[0]!]!.arm;
  // The first kept arm seeds the argmax rather than −Infinity, so an all-
  // −Infinity score set (impossible after the filter, but cheap to rule out)
  // still returns an arm instead of null.
  let best = usable[kept.index[0]!]!;
  let bestScore = -Infinity;
  kept.index.forEach((i, k) => {
    const a = usable[i]!;
    const score = sampleBeta(a.alpha, a.beta, rand) * kept.mults[k]!;
    if (score > bestScore) { best = a; bestScore = score; }
  });
  return best.arm;
}
