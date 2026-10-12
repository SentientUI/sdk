import { sampleBeta } from './bandit';
import { POOL_ALL, posteriorOfCounts, type PoolCounts } from './pooling';
import { SHRINKAGE_M } from './shrinkage';

/**
 * Context-partitioned learning with a relative-effect prior
 * (docs/buying-stage-retargeting-2026-10-09.md, "The statistical core").
 *
 * A visit's CONTEXT (a funnel stage, or a strong-intent arrival class) is a
 * partition: arms are compared only on that context's own traffic. Contexts
 * differ wildly in base rate — a cart-recovery click converts many times more
 * often than a first visit — so the obvious way to let a thin context borrow
 * from the others, shrinking its cells toward the all-context cell, would carry
 * those base rates straight into the comparison: an arm served only in a
 * high-converting context would beat the original on population alone. What
 * crosses contexts here is an arm's EFFECT relative to the reference arm (the
 * original, which every context serves), on the log-odds scale, never a rate.
 *
 * For a decision in context s:
 *
 *   ref(s)    = Beta(1,1) + the reference's own counts in s
 *   δ_a(−s)   = precision-weighted mean over contexts c ≠ s of
 *               logit p̂_a,c − logit p̂_ref,c, shrunk toward 0 by a N(0, σ₀²)
 *               prior; its variance v_δ = 1 / (Σw + 1/σ₀²)
 *   anchor r  = a DRAW from ref(s) (sampleContextArm) or its mean (reporting)
 *   prior_a   = mean logistic(logit r + δ_a), worth
 *               n_eff = 1 / ((v_δ + τ²) · p(1 − p)) pseudo-trials
 *   arm_a(s)  = Beta(n_eff·mean + 1 + conversions, n_eff·(1 − mean) + 1 + failures)
 *
 * Three decisions, each forced by a failure the simulation caught or exists to
 * catch (context-prior.sim.test.ts):
 *
 * - Leave-context-out: a prior never re-counts the data it is a prior for. An
 *   arm with no data outside `s` (a context-only version) gets δ = 0 and starts
 *   at the reference's rate in `s` — it must beat the original on that
 *   context's own traffic, which is the fair test.
 * - The reference borrows from nothing. Across contexts its rate IS the base
 *   rate; within a context the only other data is other arms'. A draft shrank
 *   it toward the context's all-arm rate: once the original was losing and
 *   thinly served, that rate was mostly the WINNER's, so the control was pulled
 *   up to the treatment and the gap closed. (The existing hierarchy keeps the
 *   same discipline: an arm only ever shrinks toward its own parent cell.)
 * - The draw is CORRELATED. What other contexts know is the DIFFERENCE between
 *   an arm and the original; independent Beta draws cannot express a
 *   well-known difference when the original's own rate in a thin context is
 *   uncertain, so borrowing bought nothing over learning alone. Anchoring each
 *   arm's prior on the same draw of the reference makes the difference, not
 *   the levels, what is shared. τ (EFFECT_HETEROGENEITY_SD) bounds how much is
 *   shared: effects genuinely differ by stage, which is why stage-specific
 *   versions exist at all.
 *
 * This is the ROOT of a context's tree; the segment × persona hierarchy nests
 * under it (plan, Phase 4.3). Pure, like everything in this package: it never
 * touches a weight row, and an external prior never reaches it — every count is
 * the site's own.
 */

export type ContextArmCounts = PoolCounts & { context: string; arm: string };

/**
 * σ₀ = 0.5 log-odds as a precision: the zero-centred prior on an arm's MEAN
 * effect (odds ratio ≈ 0.6–1.65 at one σ). An effect seen on a handful of
 * trials elsewhere barely moves; one seen on thousands carries over whole.
 */
export const EFFECT_PRIOR_PRECISION = 4;

/**
 * τ, in log-odds: how much an arm's effect is assumed to vary from one context
 * to another. Caps what a thin context borrows at ~1/(τ²·p(1−p)) pseudo-trials
 * however well the effect is known elsewhere (≈ 85 at p = 0.12). Provisional —
 * open question 3 in the design note; pinned by context-prior.sim.test.ts.
 */
export const EFFECT_HETEROGENEITY_SD = 0.35;

const EPS = 1e-6;
const clampP = (p: number): number => Math.min(1 - EPS, Math.max(EPS, p));
const logit = (p: number): number => {
  const q = clampP(p);
  return Math.log(q / (1 - q));
};
const logistic = (x: number): number => 1 / (1 + Math.exp(-x));

type Index = Map<string, Map<string, PoolCounts>>;
const ZERO: PoolCounts = { exposures: 0, conversions: 0 };

function index(rows: readonly ContextArmCounts[]): Index {
  const out: Index = new Map();
  for (const r of rows) {
    let byArm = out.get(r.context);
    if (!byArm) out.set(r.context, (byArm = new Map()));
    const cur = byArm.get(r.arm);
    // Rows are summed, not overwritten: a caller may hand in one row per
    // segment/persona cell of the same (context, arm).
    byArm.set(r.arm, cur
      ? { exposures: cur.exposures + r.exposures, conversions: cur.conversions + r.conversions }
      : { exposures: r.exposures, conversions: r.conversions });
  }
  return out;
}

type Effect = { delta: number; variance: number };

function effectFrom(idx: Index, arm: string, reference: string, ctx: string): Effect {
  let num = 0;
  let den = 0;
  for (const [c, byArm] of idx) {
    if (c === ctx) continue;
    const a = byArm.get(arm);
    const r = byArm.get(reference);
    if (!a || !r || a.exposures <= 0 || r.exposures <= 0) continue;
    // Laplace-smoothed rates, so 0/n and n/n contexts contribute a finite
    // effect with a large variance instead of ±∞.
    const pa = (a.conversions + 1) / (a.exposures + 2);
    const pr = (r.conversions + 1) / (r.exposures + 2);
    const variance = 1 / ((a.exposures + 2) * pa * (1 - pa)) + 1 / ((r.exposures + 2) * pr * (1 - pr));
    const w = 1 / variance;
    num += w * (logit(pa) - logit(pr));
    den += w;
  }
  const precision = den + EFFECT_PRIOR_PRECISION;
  return { delta: num / precision, variance: 1 / precision };
}

/** Beta for `arm` in a context, given an anchor rate for the reference there. */
function armGivenAnchor(own: PoolCounts, anchor: number, effect: Effect): { alpha: number; beta: number } {
  const mean = logistic(logit(anchor) + effect.delta);
  const v = effect.variance + EFFECT_HETEROGENEITY_SD * EFFECT_HETEROGENEITY_SD;
  const nEff = 1 / (v * Math.max(mean * (1 - mean), EPS));
  const counts = posteriorOfCounts(own);
  return { alpha: counts.alpha + nEff * mean, beta: counts.beta + nEff * (1 - mean) };
}

/**
 * Arm `arm`'s log-odds effect relative to `reference`, estimated from every
 * context except `ctx` and shrunk toward 0. 0 when no other context has served
 * both arms.
 */
export function relativeEffect(
  rows: readonly ContextArmCounts[],
  arm: string,
  reference: string,
  ctx: string,
): number {
  return arm === reference ? 0 : effectFrom(index(rows), arm, reference, ctx).delta;
}

/**
 * Thompson draw for context `ctx`: one draw of the reference anchors every
 * other arm's prior, so the shared quantity is each arm's difference from the
 * original. Returns the arm with the highest draw. `reference` (the original,
 * served in every context) must be in `arms`.
 */
export function sampleContextArm(
  rows: readonly ContextArmCounts[],
  ctx: string,
  arms: readonly string[],
  reference: string,
  rand: () => number = Math.random,
): string {
  const idx = index(rows);
  const here = idx.get(ctx) ?? new Map<string, PoolCounts>();
  const refPost = posteriorOfCounts(here.get(reference) ?? ZERO);
  const anchor = sampleBeta(refPost.alpha, refPost.beta, rand);
  let best = reference;
  let bestDraw = anchor;
  for (const arm of arms) {
    if (arm === reference) continue;
    const post = armGivenAnchor(here.get(arm) ?? ZERO, anchor, effectFrom(idx, arm, reference, ctx));
    const draw = sampleBeta(post.alpha, post.beta, rand);
    if (draw > bestDraw) {
      best = arm;
      bestDraw = draw;
    }
  }
  return best;
}

/**
 * Marginal root posteriors for context `ctx`, anchored on the reference's
 * posterior MEAN — for reporting and as the root the segment × persona
 * hierarchy nests under. Serving draws with sampleContextArm, which keeps the
 * correlation this approximation drops.
 */
export function contextRootPosteriors(
  rows: readonly ContextArmCounts[],
  ctx: string,
  arms: readonly string[],
  reference: string,
): Map<string, { alpha: number; beta: number }> {
  const idx = index(rows);
  const here = idx.get(ctx) ?? new Map<string, PoolCounts>();
  const ref = posteriorOfCounts(here.get(reference) ?? ZERO);
  const anchor = ref.alpha / (ref.alpha + ref.beta);
  const out = new Map<string, { alpha: number; beta: number }>();
  for (const arm of arms) {
    out.set(arm, arm === reference
      ? ref
      : armGivenAnchor(here.get(arm) ?? ZERO, anchor, effectFrom(idx, arm, reference, ctx)));
  }
  return out;
}

/** One context weight cell (migration 202): the root is segment = persona = '__all__'. */
export type ContextCellCounts = PoolCounts & { context: string; arm: string; segment: string; persona: string };

/**
 * sampleContextArm with the segment × persona hierarchy nested under it — the
 * serving draw (plan, Phase 4.3). Stage one is sampleContextArm's correlated
 * draw at the context ROOT (reference anchor, every other arm around anchor +
 * its leave-context-out effect). Stage two shrinks each arm's cell for this
 * visit — (context, segment, persona), or (context, segment, '__all__') when
 * the persona is not served on — toward THAT arm's root draw with `m`
 * pseudo-trials, exactly as shrunkPosterior shrinks a child toward its parent's
 * mean, and draws again. A thin cell therefore serves at its root; a thick one
 * at its own rate.
 *
 * `cell` null (or the root itself) ⇒ the root draw decides.
 */
export function sampleContextArmNested(
  rows: readonly ContextCellCounts[],
  ctx: string,
  arms: readonly string[],
  reference: string,
  cell: { segment: string; persona: string } | null,
  rand: () => number = Math.random,
  m: number = SHRINKAGE_M,
): string {
  const rootRows: ContextArmCounts[] = [];
  const childByArm = new Map<string, PoolCounts>();
  const nested = cell !== null && !(cell.segment === POOL_ALL && cell.persona === POOL_ALL);
  for (const r of rows) {
    if (r.segment === POOL_ALL && r.persona === POOL_ALL) {
      rootRows.push({ context: r.context, arm: r.arm, exposures: r.exposures, conversions: r.conversions });
    } else if (nested && r.context === ctx && r.segment === cell!.segment && r.persona === cell!.persona) {
      const cur = childByArm.get(r.arm);
      childByArm.set(r.arm, cur
        ? { exposures: cur.exposures + r.exposures, conversions: cur.conversions + r.conversions }
        : { exposures: r.exposures, conversions: r.conversions });
    }
  }
  const idx = index(rootRows);
  const here = idx.get(ctx) ?? new Map<string, PoolCounts>();
  const refPost = posteriorOfCounts(here.get(reference) ?? ZERO);
  const anchor = sampleBeta(refPost.alpha, refPost.beta, rand);

  let best = arms[0] ?? reference;
  let bestDraw = -Infinity;
  for (const arm of arms) {
    let rootDraw: number;
    if (arm === reference) {
      rootDraw = anchor;
    } else {
      const post = armGivenAnchor(here.get(arm) ?? ZERO, anchor, effectFrom(idx, arm, reference, ctx));
      rootDraw = sampleBeta(post.alpha, post.beta, rand);
    }
    let draw = rootDraw;
    if (nested) {
      const own = posteriorOfCounts(childByArm.get(arm) ?? ZERO);
      const p = Number.isFinite(rootDraw) ? Math.min(1 - EPS, Math.max(EPS, rootDraw)) : 0.5;
      draw = sampleBeta(own.alpha + m * p, own.beta + m * (1 - p), rand);
    }
    if (Number.isFinite(draw) && draw > bestDraw) {
      best = arm;
      bestDraw = draw;
    }
  }
  return best;
}

