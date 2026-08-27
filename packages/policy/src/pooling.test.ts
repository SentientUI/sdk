import { describe, expect, it } from 'vitest';
import {
  POOL_ALL, pooledPosterior, posteriorOfCounts, weightCellsFor,
  type PoolCounts,
} from './pooling';
import { shrunkPosterior } from './shrinkage';

const c = (exposures: number, conversions: number): PoolCounts => ({ exposures, conversions });

describe('posteriorOfCounts', () => {
  it('applies the pinned formulas', () => {
    expect(posteriorOfCounts(c(10, 3))).toEqual({ alpha: 4, beta: 8 });
    expect(posteriorOfCounts(c(0, 0))).toEqual({ alpha: 1, beta: 1 });
    // conversions can exceed exposures transiently (reward-leads-exposure lag) — beta floors at 1
    expect(posteriorOfCounts(c(2, 3))).toEqual({ alpha: 4, beta: 1 });
  });
});

describe('pooledPosterior — axis fallbacks (Pareto safety)', () => {
  it('personaKnown=false uses ONLY segment+global (persona/child never consulted)', () => {
    const seg = c(100, 30), glob = c(1000, 200);
    const withPersonaData = pooledPosterior(
      { segment: seg, global: glob, persona: c(500, 400), child: c(50, 45) }, false);
    const withoutPersonaData = pooledPosterior({ segment: seg, global: glob }, false);
    expect(withPersonaData).toEqual(withoutPersonaData);
    // and it equals the existing pinned one-axis shrink of segment toward global
    const expected = shrunkPosterior(posteriorOfCounts(seg), posteriorOfCounts(glob));
    expect(withPersonaData).toEqual(expected);
  });

  it('empty segment axis + populated persona axis ≈ legacy slot behavior (persona shrunk toward global)', () => {
    const per = c(80, 20), glob = c(400, 90);
    const got = pooledPosterior({ persona: per, global: glob }, true);
    const legacy = shrunkPosterior(posteriorOfCounts(per), posteriorOfCounts(glob));
    // The parent ≈ perLevel (segment has no evidence, so its blend weight is
    // ~1/(n_p+2)), and the empty child adds one more shrink on top. Since the
    // prior no longer carries the parent's sample size, that extra level leaves
    // the empty child at Beta(1,1)+m — an honestly uncertain posterior whose
    // mean sits a little nearer 0.5 than the persona level's. Ranking across
    // arms is preserved, which is what serving depends on; compare posterior
    // MEANS rather than raw counts, with room for that one Laplace step.
    const meanOf = (p: { alpha: number; beta: number }) => p.alpha / (p.alpha + p.beta);
    expect(Math.abs(meanOf(got) - meanOf(legacy))).toBeLessThan(0.05);
  });

  it('all cells empty → flat-ish prior with mean 0.5', () => {
    const got = pooledPosterior({}, true);
    expect(got.alpha / (got.alpha + got.beta)).toBeCloseTo(0.5, 5);
  });
});

describe('pooledPosterior — shrinkage behavior', () => {
  const glob = c(2000, 400);
  const seg = c(300, 90);   // segment mean 0.30
  const per = c(300, 30);   // persona mean 0.10

  it('a thin child sits near its parents; a fat child converges to its own rate', () => {
    const thin = pooledPosterior({ child: c(2, 2), segment: seg, persona: per, global: glob }, true);
    const thinMean = thin.alpha / (thin.alpha + thin.beta);
    expect(thinMean).toBeLessThan(0.5); // pulled toward parents despite 2/2 own conversions
    const fat = pooledPosterior({ child: c(100000, 90000), segment: seg, persona: per, global: glob }, true);
    const fatMean = fat.alpha / (fat.alpha + fat.beta);
    expect(fatMean).toBeGreaterThan(0.85); // own rate 0.9 dominates
  });

  it('parent blend weights each axis by its own evidence', () => {
    // Persona axis has 100x the evidence — parent should sit near persona mean 0.10, not segment 0.30
    const got = pooledPosterior(
      { child: c(0, 0), segment: c(3, 1), persona: c(300, 30), global: glob }, true);
    const mean = got.alpha / (got.alpha + got.beta);
    expect(mean).toBeLessThan(0.22);
  });

  it('is monotonic: more child conversions never lowers the posterior mean', () => {
    const base = pooledPosterior({ child: c(50, 10), segment: seg, persona: per, global: glob }, true);
    const more = pooledPosterior({ child: c(50, 20), segment: seg, persona: per, global: glob }, true);
    expect(more.alpha / (more.alpha + more.beta))
      .toBeGreaterThan(base.alpha / (base.alpha + base.beta));
  });
});

// The shape the WRITE path actually produces: weightCellsFor expands every
// trial into the child, both marginals and the global row, so `global` is the
// sum over all cells and always dwarfs any one child. The shrinkage tests above
// used a child larger than its own global row, which cannot happen in
// production — and that gap is what let STAT-01 survive review.
describe('pooledPosterior — with global as the sum of its children (real write shape)', () => {
  // One arm: a 'buyer'/'desktop:organic' cell truly converting at 20%, inside a
  // project whose other traffic converts at 2%.
  const child = c(2_000, 400);
  const seg = c(20_000, 400 + 18_000 * 0.02);
  const per = c(10_000, 400 + 8_000 * 0.02);
  const glob = c(100_000, 400 + 98_000 * 0.02);
  const meanOf = (p: { alpha: number; beta: number }): number => p.alpha / (p.alpha + p.beta);
  const sdOf = (p: { alpha: number; beta: number }): number =>
    Math.sqrt((p.alpha * p.beta) / ((p.alpha + p.beta) ** 2 * (p.alpha + p.beta + 1)));

  it('lets a well-sampled child reach its own rate rather than the project average', () => {
    const got = pooledPosterior({ child, segment: seg, persona: per, global: glob }, true);
    expect(meanOf(got)).toBeGreaterThan(0.18); // its own 0.20, not the global 0.02
  });

  it('keeps a thin child explorable — posterior no tighter than its own evidence', () => {
    const thin = c(20, 4);
    const got = pooledPosterior({ child: thin, segment: seg, persona: per, global: glob }, true);
    // The parent may only add ~m pseudo-observations, so total mass stays ~42.
    expect(got.alpha + got.beta).toBeLessThan(80);
    // …which means Thompson Sampling still draws a spread of values here. The
    // sample-size-copying form produced sd ≈ 0.002 (effectively argmax).
    expect(sdOf(got)).toBeGreaterThan(0.02);
  });

  it('shrinks a thin child toward its parents without pinning it there', () => {
    const thin = pooledPosterior({ child: c(20, 4), segment: seg, persona: per, global: glob }, true);
    const fat = pooledPosterior({ child: c(5_000, 1_000), segment: seg, persona: per, global: glob }, true);
    // Same 20% observed rate; the better-sampled cell is trusted more.
    expect(meanOf(thin)).toBeLessThan(meanOf(fat));
    expect(meanOf(thin)).toBeGreaterThan(0.02); // still above the project average
  });
});

describe('weightCellsFor', () => {
  it('known persona → 4 cells (child, segment marginal, persona marginal, global)', () => {
    expect(weightCellsFor('desktop:organic', 'buyer')).toEqual([
      { segment: 'desktop:organic', persona: 'buyer' },
      { segment: 'desktop:organic', persona: POOL_ALL },
      { segment: POOL_ALL, persona: 'buyer' },
      { segment: POOL_ALL, persona: POOL_ALL },
    ]);
  });
  it("unknown persona → 2 cells (segment marginal + global only, no 'unknown' rows)", () => {
    expect(weightCellsFor('mobile:ads', 'unknown')).toEqual([
      { segment: 'mobile:ads', persona: POOL_ALL },
      { segment: POOL_ALL, persona: POOL_ALL },
    ]);
  });

  it("empty-string persona is treated like unknown (defensive) → 2 cells, no '' child row", () => {
    expect(weightCellsFor('mobile:ads', '')).toEqual([
      { segment: 'mobile:ads', persona: POOL_ALL },
      { segment: POOL_ALL, persona: POOL_ALL },
    ]);
  });
});
