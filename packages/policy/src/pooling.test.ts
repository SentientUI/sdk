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
    const expected = shrunkPosterior(
      { ...posteriorOfCounts(seg), exposures: seg.exposures }, posteriorOfCounts(glob));
    expect(withPersonaData).toEqual(expected);
  });

  it('empty segment axis + populated persona axis ≈ legacy slot behavior (persona shrunk toward global)', () => {
    const per = c(80, 20), glob = c(400, 90);
    const got = pooledPosterior({ persona: per, global: glob }, true);
    const legacy = shrunkPosterior(
      { ...posteriorOfCounts(per), exposures: per.exposures }, posteriorOfCounts(glob));
    // child empty → w=1 → Beta(1,1) + parent, and parent ≈ perLevel (segment has no
    // evidence, so its blend weight is ~1/(n_p+2)). Compare posterior MEANS — the
    // serving-relevant quantity — rather than raw counts.
    const meanOf = (p: { alpha: number; beta: number }) => p.alpha / (p.alpha + p.beta);
    expect(Math.abs(meanOf(got) - meanOf(legacy))).toBeLessThan(0.01);
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
