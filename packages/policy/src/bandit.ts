/** Learned Beta(alpha, beta) posterior for one arm. */
export type ArmPosterior = { arm: string; alpha: number; beta: number };

// Marsaglia-Tsang method for Gamma(shape, 1) samples. Defined for shape > 0
// only; sampleBeta guards its inputs before calling this.
function sampleGamma(shape: number, rand: () => number): number {
  if (shape < 1) {
    return sampleGamma(1 + shape, rand) * Math.pow(Math.max(1e-15, rand()), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      const u1 = Math.max(1e-15, rand());
      const u2 = rand();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Whether (alpha, beta) is a usable Beta posterior: both shapes finite and
 * strictly positive. Fractional shapes in (0, 1) are legitimate (fractional
 * credit and shrinkage produce them); NaN, ±Infinity, 0 and negatives are not.
 * They come only from corrupt state — a NaN written into a weight column, a
 * clawback driving a count below −1 — and Beta(alpha, beta) is undefined there.
 */
export function isValidBetaShape(alpha: number, beta: number): boolean {
  return Number.isFinite(alpha) && Number.isFinite(beta) && alpha > 0 && beta > 0;
}

/**
 * The arms whose posterior is not a usable Beta (isValidBetaShape), in input
 * order. Pure: a caller that can log (the API) uses it to surface the corrupt
 * row; the samplers exclude these arms on their own either way.
 */
export function invalidPosteriorArms<T extends { alpha: number; beta: number }>(arms: readonly T[]): T[] {
  return arms.filter((a) => !isValidBetaShape(a.alpha, a.beta));
}

/**
 * The arms a Thompson draw actually runs over.
 *
 * A corrupt posterior is EXCLUDED, not reset to the Beta(1,1) prior. A reset
 * looks safer and is not: a corrupt row never heals — close-out keeps adding to
 * it, and NaN + x is NaN — so the arm would be drawn from Beta(1,1) forever, and
 * a uniform draw beats a well-measured 5% arm 95% of the time. The "repaired"
 * arm would capture nearly all of the traffic, permanently, while learning
 * nothing. Exclusion gives it probability 0, which is right for an arm we hold
 * no trustworthy measurement of and cannot acquire one for until the row is
 * repaired.
 *
 * The one exception: when EVERY arm is corrupt there is no measured arm left to
 * protect, and each is drawn from Beta(1,1) — a uniform pick, so nothing
 * captures anything — instead of returning no decision and handing the caller a
 * fallback its logged propensities would not describe.
 *
 * `index[k]` is the input position of `arms[k]`, so a propensity vector
 * computed over `arms` can be scattered back (zeros for the excluded) and stay
 * parallel to the candidate list the caller logs.
 */
export function usablePosteriors<T extends { alpha: number; beta: number }>(
  arms: readonly T[],
): { arms: T[]; index: number[] } {
  const index: number[] = [];
  arms.forEach((a, i) => {
    if (isValidBetaShape(a.alpha, a.beta)) index.push(i);
  });
  if (index.length === arms.length) return { arms: [...arms], index };
  if (index.length === 0) {
    return { arms: arms.map((a) => ({ ...a, alpha: 1, beta: 1 })), index: arms.map((_, i) => i) };
  }
  return { arms: index.map((i) => arms[i]!), index };
}

/**
 * One draw from Beta(alpha, beta). Moved verbatim from apps/api/src/domain/bandit.ts.
 *
 * Returns NaN — "no draw" — when the shapes are not a usable Beta
 * (isValidBetaShape). The gamma sampler used to run on them anyway: NaN shapes
 * came back NaN, a shape in (−1, 0) raised a uniform to a large negative power
 * and exploded, alpha = beta = 0 divided 0 by 0. NaN is the one value no argmax
 * in this package can pick (`s > best` is false for it, and every loop starts
 * from −Infinity or a usable arm), so the factored models, which call this per
 * cell, drop a corrupt cell's candidates instead of ranking on garbage.
 *
 * @param rand Uniform [0,1) source. Defaults to `Math.random`, which is
 *   NON-DETERMINISTIC. Pass a seeded PRNG when you need reproducible output
 *   (tests, replayable decisions, snapshotting) — otherwise results vary per call.
 */
export function sampleBeta(alpha: number, beta: number, rand: () => number = Math.random): number {
  if (!isValidBetaShape(alpha, beta)) return NaN;
  const a = sampleGamma(alpha, rand);
  const b = sampleGamma(beta, rand);
  const total = a + b;
  return total <= 0 ? alpha / (alpha + beta) : a / total;
}

/**
 * Thompson Sampling selection: samples Beta(alpha, beta) per arm and returns
 * the argmax arm id, or null when no arms are given. Uncertain arms get
 * explored; confident winners get exploited — same semantics as the legacy
 * chooseVariant, generalized to arbitrary arm strings.
 *
 * Arms with a corrupt posterior are excluded from the draw (usablePosteriors);
 * if every arm is corrupt the pick is uniform. Before this guard a NaN draw on
 * the FIRST arm won every argmax — nothing compares greater than NaN — so one
 * corrupt row captured 100% of a component's traffic. With valid posteriors
 * the draw, and its consumption of `rand`, is unchanged.
 *
 * @param rand Uniform [0,1) source. Defaults to `Math.random`, which is
 *   NON-DETERMINISTIC. Pass a seeded PRNG for reproducible selection (tests,
 *   replayable assignments) — otherwise the chosen arm varies per call.
 */
export function sampleArm(arms: ArmPosterior[], rand: () => number = Math.random): string | null {
  if (arms.length === 0) return null;
  if (arms.length === 1) return arms[0]!.arm;

  const usable = usablePosteriors(arms).arms;
  if (usable.length === 1) return usable[0]!.arm;
  let best = usable[0]!;
  let bestSample = sampleBeta(best.alpha, best.beta, rand);
  for (let i = 1; i < usable.length; i++) {
    const a = usable[i]!;
    const s = sampleBeta(a.alpha, a.beta, rand);
    if (s > bestSample) {
      best = a;
      bestSample = s;
    }
  }
  return best.arm;
}
