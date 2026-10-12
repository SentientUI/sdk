import { describe, expect, it } from 'vitest';
import { sampleArm, type ArmPosterior } from './bandit';
import { sampleContextArm, type ContextArmCounts } from './context-prior';
import { posteriorOfCounts } from './pooling';

// Gate A of docs/buying-stage-implementation-plan-2026-10-09.md (step 0.2):
// prove the relative-effect prior on synthetic traffic where the truth is
// known, BEFORE any replay or serving change. Each case pits the context
// policy against the policy whose failure it exists to prevent:
//   pooled   — one cell per arm across all contexts (no partition);
//   isolated — each context learns alone (partition, no borrowing).
// The whole file runs in about a second, so unlike the permutation-null cases
// in slot-replay-sim.test.ts it is NOT skipped on CI: a change to the prior
// that breaks one of these properties must fail the push.

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

type Ctx = { name: string; share: number; truth: Record<string, number> };
type Policy = 'context' | 'pooled' | 'isolated';
type Counts = { exposures: number; conversions: number };
type Run = { counts: Map<string, Map<string, Counts>>; late: Map<string, Map<string, number>> };

const REF = 'original';

function rowsOf(counts: Run['counts']): ContextArmCounts[] {
  const rows: ContextArmCounts[] = [];
  for (const [context, byArm] of counts) {
    for (const [arm, c] of byArm) rows.push({ context, arm, ...c });
  }
  return rows;
}

function independentPosteriors(policy: 'pooled' | 'isolated', counts: Run['counts'], ctx: string, arms: string[]): ArmPosterior[] {
  return arms.map((arm) => {
    let c: Counts = { exposures: 0, conversions: 0 };
    if (policy === 'isolated') {
      c = counts.get(ctx)?.get(arm) ?? c;
    } else {
      for (const byArm of counts.values()) {
        const x = byArm.get(arm);
        if (x) c = { exposures: c.exposures + x.exposures, conversions: c.conversions + x.conversions };
      }
    }
    return { arm, ...posteriorOfCounts(c) };
  });
}

/** One Thompson decision under `policy`. */
function choose(policy: Policy, counts: Run['counts'], ctx: string, arms: string[], rand: () => number): string {
  return policy === 'context'
    ? sampleContextArm(rowsOf(counts), ctx, arms, REF, rand)
    : sampleArm(independentPosteriors(policy, counts, ctx, arms), rand)!;
}

/** Thompson sampling over `n` visits; `late` counts serves in the final `lateShare` of the run. */
function simulate(ctxs: Ctx[], policy: Policy, n: number, seed: number, lateShare = 0.3): Run {
  const rand = lcg(seed);
  const counts: Run['counts'] = new Map(ctxs.map((c) => [c.name, new Map()]));
  const late: Run['late'] = new Map(ctxs.map((c) => [c.name, new Map()]));
  const lateFrom = Math.floor(n * (1 - lateShare));
  for (let i = 0; i < n; i++) {
    let u = rand();
    const ctx = ctxs.find((c) => (u -= c.share) < 0) ?? ctxs[ctxs.length - 1]!;
    const arms = Object.keys(ctx.truth);
    const arm = choose(policy, counts, ctx.name, arms, rand);
    const converted = rand() < ctx.truth[arm]!;
    const byArm = counts.get(ctx.name)!;
    const c = byArm.get(arm) ?? { exposures: 0, conversions: 0 };
    byArm.set(arm, { exposures: c.exposures + 1, conversions: c.conversions + (converted ? 1 : 0) });
    if (i >= lateFrom) {
      const l = late.get(ctx.name)!;
      l.set(arm, (l.get(arm) ?? 0) + 1);
    }
  }
  return { counts, late };
}

/** Share of `arm` among the late serves in `ctxNames`. */
function lateShareOf(run: Run, ctxNames: string[], arm: string): number {
  let hit = 0;
  let all = 0;
  for (const name of ctxNames) {
    for (const [a, k] of run.late.get(name)!) {
      all += k;
      if (a === arm) hit += k;
    }
  }
  return all === 0 ? NaN : hit / all;
}

/** Share of `arm` among ALL serves in `ctx` over the run. */
function runShareOf(run: Run, ctx: string, arm: string): number {
  let hit = 0;
  let all = 0;
  for (const [a, c] of run.counts.get(ctx)!) {
    all += c.exposures;
    if (a === arm) hit += c.exposures;
  }
  return all === 0 ? NaN : hit / all;
}

const avg = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

describe('context prior — confounding by base rate', () => {
  // A version served only where conversion is naturally high. Among its own
  // visitors it is WORSE than the original; pooled, it looks several times
  // better because the original's cell is dominated by 2% traffic.
  const ctxs: Ctx[] = [
    { name: 'new', share: 0.8, truth: { original: 0.02 } },
    { name: 'carted', share: 0.12, truth: { original: 0.12, reminder: 0.08 } },
    { name: 'cart_recovery', share: 0.08, truth: { original: 0.3, matched: 0.24 } },
  ];

  it('the context policy keeps serving the original where the restricted version is worse', () => {
    const run = simulate(ctxs, 'context', 20_000, 7);
    expect(lateShareOf(run, ['carted'], 'reminder')).toBeLessThan(0.35);
    expect(lateShareOf(run, ['cart_recovery'], 'matched')).toBeLessThan(0.35);
  });

  it('documents the bug it prevents: a pooled policy serves the worse restricted version', () => {
    const run = simulate(ctxs, 'pooled', 20_000, 7);
    expect(lateShareOf(run, ['carted'], 'reminder')).toBeGreaterThan(0.65);
    expect(lateShareOf(run, ['cart_recovery'], 'matched')).toBeGreaterThan(0.65);
  });
});

describe('context prior — exclusion', () => {
  // `b` is better everywhere it runs but is excluded from the high-converting
  // `customer` context, so its pooled cell never sees those conversions.
  const ctxs: Ctx[] = [
    { name: 'new', share: 0.6, truth: { original: 0.02, b: 0.03 } },
    { name: 'browsing', share: 0.25, truth: { original: 0.04, b: 0.06 } },
    { name: 'customer', share: 0.15, truth: { original: 0.2 } },
  ];

  it('the context policy does not penalize an arm for the contexts it is excluded from', () => {
    const run = simulate(ctxs, 'context', 20_000, 11);
    expect(lateShareOf(run, ['new', 'browsing'], 'b')).toBeGreaterThan(0.6);
  });

  it('documents the bug it prevents: a pooled policy prefers the original', () => {
    const run = simulate(ctxs, 'pooled', 20_000, 11);
    expect(lateShareOf(run, ['new', 'browsing'], 'b')).toBeLessThan(0.4);
  });
});

describe('context prior — multi-seed', () => {
  const SEEDS = Array.from({ length: 12 }, (_, i) => 101 + i);

  it('a thin context borrows an effect seen elsewhere and exploits it sooner than learning alone', () => {
    // The same +45% odds effect in every context; `lapsed` is 0.5% of traffic
    // (~150 visits). Borrowing is capped by EFFECT_HETEROGENEITY_SD — effects
    // may differ by context — so its edge is largest in genuinely thin
    // contexts and fades as a context's own data catch up (measured
    // 2026-10-09, 24 seeds: 60 visits 0.69 vs 0.56, 150 visits 0.78 vs 0.58,
    // 300 visits 0.76 vs 0.69).
    const ctxs: Ctx[] = [
      { name: 'new', share: 0.6, truth: { original: 0.02, c: 0.029 } },
      { name: 'browsing', share: 0.395, truth: { original: 0.04, c: 0.057 } },
      { name: 'lapsed', share: 0.005, truth: { original: 0.1, c: 0.139 } },
    ];
    const seeds = Array.from({ length: 24 }, (_, i) => 101 + i);
    const context = avg(seeds.map((s) => runShareOf(simulate(ctxs, 'context', 30_000, s), 'lapsed', 'c')));
    const isolated = avg(seeds.map((s) => runShareOf(simulate(ctxs, 'isolated', 30_000, s), 'lapsed', 'c')));
    expect(context).toBeGreaterThan(isolated + 0.08);
  });

  it('identical arms: borrowing does not manufacture confident winners', () => {
    // No arm is better anywhere. A "confident winner" is a final posterior
    // P(x > original) outside [0.05, 0.95] in a context. Compared with
    // learning each context alone — borrowing must not inflate it.
    const ctxs: Ctx[] = [
      { name: 'new', share: 0.7, truth: { original: 0.03, x: 0.03 } },
      { name: 'carted', share: 0.3, truth: { original: 0.12, x: 0.12 } },
    ];
    const confident = (policy: Policy, seed: number): number => {
      const run = simulate(ctxs, policy, 15_000, seed);
      const rand = lcg(seed * 31 + 1);
      let hits = 0;
      for (const ctx of ['new', 'carted']) {
        // P(x is best) as the policy itself would act on it: the share of its
        // own Thompson draws that pick x.
        let wins = 0;
        const draws = 2_000;
        for (let i = 0; i < draws; i++) {
          if (choose(policy, run.counts, ctx, ['original', 'x'], rand) === 'x') wins++;
        }
        const p = wins / draws;
        if (p > 0.95 || p < 0.05) hits++;
      }
      return hits / 2;
    };
    const context = avg(SEEDS.map((s) => confident('context', s)));
    const isolated = avg(SEEDS.map((s) => confident('isolated', s)));
    expect(context).toBeLessThanOrEqual(isolated + 0.1);
    expect(context).toBeLessThan(0.25);
  });
});
