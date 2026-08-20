// Parallel value posterior (Shopify revenue spec §7): EV-ranked serving as
// thompsonDraw(alpha, beta) × EB-shrunk average order value. With no value
// data the shrunk average IS the reference — a constant factor — so EV
// ranking degrades exactly to CVR ranking. Rollout-gated per project
// (ev_serving), never plan-gated.
import { sampleBeta, type ArmPosterior } from './bandit';

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

export function sampleArmEv(arms: EvArm[], reference: number, rand: () => number = Math.random): string | null {
  if (arms.length === 0) return null;
  if (arms.length === 1) return arms[0]!.arm;
  let best: EvArm | null = null;
  let bestScore = -Infinity;
  for (const a of arms) {
    const score = sampleBeta(a.alpha, a.beta, rand) * shrunkAvgValue(a, reference);
    if (score > bestScore) { best = a; bestScore = score; }
  }
  return best!.arm;
}
