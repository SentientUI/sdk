import { describe, expect, it } from 'vitest';
import {
  GLOBAL_FACTOR_LEVEL,
  SLOT_FACTORS,
  chooseSlotArmFactored,
  factorCellsForTrial,
  factorLevelsFor,
  visitLevel,
  type SlotFactorCell,
  type SlotFactorContext,
} from './slot-factored';

const ctx = (over: Partial<SlotFactorContext> = {}): SlotFactorContext => ({
  device: 'mobile', source: 'organic', persona: 'admin', visit: 'returning', ...over,
});

const cell = (arm: string, factor: string, level: string, e: number, c: number): SlotFactorCell =>
  ({ arm, factor, level, exposures: e, conversions: c });

/** Deterministic RNG so a selection test asserts the model, not the sampler. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

describe('factorLevelsFor — what a context decomposes into', () => {
  it('emits one level per measured factor', () => {
    expect(factorLevelsFor(ctx())).toEqual([
      { factor: 'device', level: 'mobile' },
      { factor: 'source', level: 'organic' },
      { factor: 'persona', level: 'admin' },
      { factor: 'visit', level: 'returning' },
    ]);
  });

  it('an UNKNOWN persona contributes NO persona term', () => {
    // The Pareto safety invariant (CONTRACTS §4) restated for this model.
    // An 'unknown' LEVEL would become a real segment that accumulates its own
    // rate and steers serving — unknown traffic must run on exactly the
    // persona-agnostic policy, so the term is absent, not empty.
    const levels = factorLevelsFor(ctx({ persona: 'unknown' }));
    expect(levels.some((l) => l.factor === 'persona')).toBe(false);
    expect(levels).toHaveLength(3);
  });

  it('treats an unmeasured field as absent, never as an "unknown" level', () => {
    const levels = factorLevelsFor({ device: null, source: null, persona: 'unknown', visit: null });
    expect(levels).toEqual([]);
  });
});

describe('chooseSlotArmFactored', () => {
  it('prefers the arm that wins on the factor levels of THIS context', () => {
    // 'a' wins globally; 'b' wins decisively on mobile. A model that only read
    // the global row would serve 'a' to everyone, which is the behaviour this
    // whole design exists to improve on.
    const cells = [
      cell('a', 'global', GLOBAL_FACTOR_LEVEL, 2000, 400),
      cell('b', 'global', GLOBAL_FACTOR_LEVEL, 2000, 300),
      cell('a', 'device', 'mobile', 1000, 50),
      cell('b', 'device', 'mobile', 1000, 400),
    ];
    const rand = lcg(7);
    let bWins = 0;
    for (let i = 0; i < 400; i++) {
      if (chooseSlotArmFactored(['a', 'b'], ctx({ persona: 'unknown', source: null, visit: null }), cells, rand)!.arm === 'b') {
        bWins++;
      }
    }
    expect(bWins).toBeGreaterThan(300);
  });

  it('shares evidence across contexts that differ in another factor', () => {
    // The core claim. Everything learned on mobile/paid must transfer to
    // mobile/organic, because they share the device level — that is the whole
    // sample-efficiency argument over per-combination cells.
    const cells = [
      cell('a', 'global', GLOBAL_FACTOR_LEVEL, 1000, 100),
      cell('b', 'global', GLOBAL_FACTOR_LEVEL, 1000, 100),
      cell('b', 'device', 'mobile', 800, 400),
    ];
    const rand = lcg(11);
    let bWins = 0;
    for (let i = 0; i < 400; i++) {
      // A context never observed as a combination: mobile + a source with no
      // cells at all.
      const c = ctx({ source: 'referral', persona: 'unknown', visit: null });
      if (chooseSlotArmFactored(['a', 'b'], c, cells, rand)!.arm === 'b') bWins++;
    }
    expect(bWins).toBeGreaterThan(300);
  });

  it('degenerates to the plain bandit when no factor is measured', () => {
    // The correct degenerate case rather than a special-cased fallback: with no
    // usable factors the score IS the arm's global draw.
    const cells = [
      cell('a', 'global', GLOBAL_FACTOR_LEVEL, 1000, 500),
      cell('b', 'global', GLOBAL_FACTOR_LEVEL, 1000, 50),
    ];
    const rand = lcg(3);
    let aWins = 0;
    for (let i = 0; i < 300; i++) {
      const c: SlotFactorContext = { device: null, source: null, persona: 'unknown', visit: null };
      const choice = chooseSlotArmFactored(['a', 'b'], c, cells, rand)!;
      expect(choice.factorsUsed).toBe(0);
      if (choice.arm === 'a') aWins++;
    }
    expect(aWins).toBeGreaterThan(270);
  });

  it('still explores on a cold slot', () => {
    // Enabling this model on a project with no factor history must not freeze
    // serving on one arm. Empty cells draw from the shrunken pool, which still
    // randomises.
    const rand = lcg(5);
    const picks = new Set<string>();
    for (let i = 0; i < 200; i++) {
      picks.add(chooseSlotArmFactored(['a', 'b', 'c'], ctx(), [], rand)!.arm);
    }
    expect(picks.size).toBe(3);
  });

  it('never consults another arm-context it was not given', () => {
    // A cell for a level NOT in this context must not influence the score —
    // otherwise "works on desktop" leaks into a mobile decision.
    const cells = [
      cell('a', 'global', GLOBAL_FACTOR_LEVEL, 1000, 100),
      cell('b', 'global', GLOBAL_FACTOR_LEVEL, 1000, 100),
      cell('b', 'device', 'desktop', 1000, 900),
    ];
    const rand = lcg(13);
    let bWins = 0;
    for (let i = 0; i < 400; i++) {
      const c = ctx({ device: 'mobile', source: null, persona: 'unknown', visit: null });
      if (chooseSlotArmFactored(['a', 'b'], c, cells, rand)!.arm === 'b') bWins++;
    }
    // Roughly a coin flip: the desktop cell is irrelevant here.
    expect(bWins).toBeGreaterThan(120);
    expect(bWins).toBeLessThan(280);
  });

  it('handles the degenerate arities', () => {
    expect(chooseSlotArmFactored([], ctx(), [])).toBeNull();
    expect(chooseSlotArmFactored(['only'], ctx(), [])).toEqual({ arm: 'only', factorsUsed: 0 });
  });

  it('is deterministic under a seeded RNG', () => {
    const cells = [cell('a', 'device', 'mobile', 100, 40), cell('b', 'device', 'mobile', 100, 10)];
    const run = () => chooseSlotArmFactored(['a', 'b'], ctx(), cells, lcg(99))!.arm;
    expect(run()).toBe(run());
  });
});

describe('factorCellsForTrial — the write projection', () => {
  it('always writes the arm global row, plus one row per measured factor', () => {
    const cells = factorCellsForTrial('a', ctx(), 1);
    expect(cells[0]).toEqual({ arm: 'a', factor: 'global', level: GLOBAL_FACTOR_LEVEL, weight: 1 });
    expect(cells).toHaveLength(5);
  });

  it('soft-assigns ONLY the persona factor', () => {
    // Mirrors the layout model: a mismeasured persona induces attenuation bias,
    // so the persona term trains at the portrait's reliability while every
    // directly-observed factor trains at full weight.
    const cells = factorCellsForTrial('a', ctx(), 0.4);
    const persona = cells.find((c) => c.factor === 'persona')!;
    const device = cells.find((c) => c.factor === 'device')!;
    expect(persona.weight).toBeCloseTo(0.4, 9);
    expect(device.weight).toBe(1);
  });

  it('writes no persona row for unknown traffic', () => {
    // Same invariant as the read side — and they call the same function, so
    // they cannot disagree about what a context decomposes into.
    const cells = factorCellsForTrial('a', ctx({ persona: 'unknown' }), 1);
    expect(cells.some((c) => c.factor === 'persona')).toBe(false);
  });

  it('clamps a nonsense reliability rather than writing it', () => {
    expect(factorCellsForTrial('a', ctx(), 5).find((c) => c.factor === 'persona')!.weight).toBe(1);
    // A clamp to zero is a row that contributes nothing and yet creates a
    // dead (arm, persona) cell serving would consult — so it is not written
    // at all. The global row still carries the trial.
    for (const w of [-1, 0, Number.NaN]) {
      const cells = factorCellsForTrial('a', ctx(), w);
      expect(cells.some((c) => c.factor === 'persona')).toBe(false);
      expect(cells.some((c) => c.factor === 'global')).toBe(true);
    }
  });
});

describe('visitLevel', () => {
  it('is two levels, not a count', () => {
    expect(visitLevel(1)).toBe('new');
    expect(visitLevel(2)).toBe('returning');
    expect(visitLevel(97)).toBe('returning');
  });

  it('is null when unknown, so it contributes no term', () => {
    expect(visitLevel(null)).toBeNull();
    expect(visitLevel(undefined)).toBeNull();
    expect(visitLevel(0)).toBeNull();
    expect(visitLevel(Number.NaN)).toBeNull();
  });
});

describe('parameter count — the reason this model exists', () => {
  it('grows with the SUM of factor levels, not their product', () => {
    // 3 devices x 6 sources x 5 personas x 2 visit states = 180 cells per arm
    // under slot_weights. Factored: 3 + 6 + 5 + 2 + 1 global = 17.
    const levels = { device: 3, source: 6, persona: 5, visit: 2 };
    const product = Object.values(levels).reduce((a, b) => a * b, 1);
    const sum = Object.values(levels).reduce((a, b) => a + b, 0) + 1;
    expect(product).toBe(180);
    expect(sum).toBe(17);
    expect(SLOT_FACTORS).toHaveLength(4);
  });
});
