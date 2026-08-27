import { SHRINKAGE_M, shrunkPosterior } from './shrinkage';

/** Sentinel segment/persona value for marginal and global weight rows. */
export const POOL_ALL = '__all__';

export type PoolCounts = { exposures: number; conversions: number };
export type PoolCells = {
  /** (segment, persona) — the specific serving context */
  child?: PoolCounts;
  /** (segment, '__all__') — persona-agnostic marginal (legacy variant rows) */
  segment?: PoolCounts;
  /** ('__all__', persona) — segment-agnostic marginal (legacy slot rows) */
  persona?: PoolCounts;
  /** ('__all__', '__all__') — global */
  global?: PoolCounts;
};

const ZERO: PoolCounts = { exposures: 0, conversions: 0 };

/** Pinned formulas: alpha = conversions + 1; beta = max(0, exposures − conversions) + 1. */
export function posteriorOfCounts(c: PoolCounts): { alpha: number; beta: number } {
  return { alpha: c.conversions + 1, beta: Math.max(0, c.exposures - c.conversions) + 1 };
}

/**
 * Hierarchical partial pooling over (segment, persona), built by nesting the
 * pinned one-axis shrinkage (shrunkPosterior, m = SHRINKAGE_M):
 *
 *   segLevel = shrink(segment ← global)
 *   perLevel = shrink(persona ← global)                (persona axis, when known)
 *   parent   = evidence-weighted blend of segLevel and perLevel
 *   final    = shrink(child ← parent)
 *
 * personaKnown=false consults ONLY segment+global — this is the invariant that
 * keeps unknown-persona traffic on exactly the segment-marginal policy.
 * Every cell is optional; an absent cell contributes Beta(1,1)-with-0-evidence,
 * which is what lets the same function reproduce the legacy variant (segment-only)
 * and legacy slot (persona-only) behaviors on day one after migration.
 *
 * Only the parent's MEAN crosses each shrink boundary (see shrunkPosterior) —
 * never its sample size. That is what keeps a thin child's posterior as WIDE as
 * its own evidence warrants, so Thompson Sampling still explores it. The blend
 * weight below therefore decides which axis sets the parent's rate; the levels'
 * absolute magnitudes no longer leak into the child's confidence.
 */
export function pooledPosterior(
  cells: PoolCells,
  personaKnown: boolean,
  m: number = SHRINKAGE_M,
): { alpha: number; beta: number } {
  const seg = cells.segment ?? ZERO;
  const glob = cells.global ?? ZERO;
  const globPost = posteriorOfCounts(glob);

  const segLevel = shrunkPosterior(posteriorOfCounts(seg), globPost, m);
  if (!personaKnown) return segLevel;

  const per = cells.persona ?? ZERO;
  const child = cells.child ?? ZERO;
  const perLevel = shrunkPosterior(posteriorOfCounts(per), globPost, m);

  // Laplace-smoothed evidence weighting: an axis with no data gets (near-)zero
  // say; equal data → equal say; both empty → 50/50 (≈ global either way).
  const wSeg = (seg.exposures + 1) / (seg.exposures + per.exposures + 2);
  const parent = {
    alpha: wSeg * segLevel.alpha + (1 - wSeg) * perLevel.alpha,
    beta: wSeg * segLevel.beta + (1 - wSeg) * perLevel.beta,
  };
  return shrunkPosterior(posteriorOfCounts(child), parent, m);
}

/** A weight row's value-posterior columns, plus the cell it belongs to. */
export type ValueCellRow = {
  segment: string;
  persona: string;
  valueSum: number;
  valueCount: number;
};

/**
 * The value cell for EV ranking: the BROADEST cell present for an arm.
 *
 * Never a sum across cells. `weightCellsFor` writes each trial to the child,
 * both marginals AND the global row, so adding them up counts every real order
 * 2-4x depending on whether the persona was known. The average survives that
 * (numerator and denominator inflate together) but the EB shrinkage weight does
 * not: `valueCount / (valueCount + EV_SHRINK_K)` with K = 20 is meant to give a
 * cell its own voice at ~20 valued orders, and at 4x inflation it happened at
 * 5 — by a factor that varied with the arm's persona mix, so identical arms
 * shrank differently.
 *
 * The broadest cell already holds every trial in its slice exactly once, which
 * makes this correct for both serving views: the pooled hierarchy (up to four
 * rows per arm, global wins) and the legacy marginal view (exactly one row per
 * arm, which is therefore the broadest).
 */
export function broadestValueCell(rows: readonly ValueCellRow[]): { valueSum: number; valueCount: number } {
  let best: ValueCellRow | null = null;
  let bestRank = -1;
  for (const row of rows) {
    const segAll = row.segment === POOL_ALL;
    const perAll = row.persona === POOL_ALL;
    const rank = segAll && perAll ? 3 : segAll || perAll ? 2 : 1;
    if (rank > bestRank) {
      bestRank = rank;
      best = row;
    }
  }
  return { valueSum: best?.valueSum ?? 0, valueCount: best?.valueCount ?? 0 };
}

/**
 * Write-side cell expansion: which weight rows one trial/credit must bump.
 * Unknown persona bumps ONLY the segment marginal + global — no 'unknown'
 * child or persona-marginal rows exist (unknown traffic serves the segment
 * marginal, so that is where its evidence must live).
 */
export function weightCellsFor(
  segment: string,
  persona: string,
): Array<{ segment: string; persona: string }> {
  // '' is treated like unknown defensively: an empty persona carries no signal,
  // so its evidence belongs on the segment marginal + global, never a '' child row.
  if (persona === 'unknown' || persona === POOL_ALL || persona === '') {
    return [
      { segment, persona: POOL_ALL },
      { segment: POOL_ALL, persona: POOL_ALL },
    ];
  }
  return [
    { segment, persona },
    { segment, persona: POOL_ALL },
    { segment: POOL_ALL, persona },
    { segment: POOL_ALL, persona: POOL_ALL },
  ];
}
