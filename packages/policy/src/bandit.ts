/** Learned Beta(alpha, beta) posterior for one arm. */
export type ArmPosterior = { arm: string; alpha: number; beta: number };

// Marsaglia-Tsang method for Gamma(shape, 1) samples.
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
 * One draw from Beta(alpha, beta). Moved verbatim from apps/api/src/domain/bandit.ts.
 *
 * @param rand Uniform [0,1) source. Defaults to `Math.random`, which is
 *   NON-DETERMINISTIC. Pass a seeded PRNG when you need reproducible output
 *   (tests, replayable decisions, snapshotting) — otherwise results vary per call.
 */
export function sampleBeta(alpha: number, beta: number, rand: () => number = Math.random): number {
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
 * @param rand Uniform [0,1) source. Defaults to `Math.random`, which is
 *   NON-DETERMINISTIC. Pass a seeded PRNG for reproducible selection (tests,
 *   replayable assignments) — otherwise the chosen arm varies per call.
 */
export function sampleArm(arms: ArmPosterior[], rand: () => number = Math.random): string | null {
  if (arms.length === 0) return null;
  if (arms.length === 1) return arms[0]!.arm;

  let best = arms[0]!;
  let bestSample = sampleBeta(best.alpha, best.beta, rand);
  for (let i = 1; i < arms.length; i++) {
    const a = arms[i]!;
    const s = sampleBeta(a.alpha, a.beta, rand);
    if (s > bestSample) {
      best = a;
      bestSample = s;
    }
  }
  return best.arm;
}
