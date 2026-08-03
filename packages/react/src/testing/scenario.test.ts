import { describe, expect, it } from 'vitest';
import { applyScenario, resetScenario } from './scenario';

type W = { __sentient_overrides?: Record<string, string>; __sentient_layout_override?: string[] };

describe('scenario helpers', () => {
  it('applyScenario sets variant + layout globals', () => {
    applyScenario({ variants: { hero: 'b' }, layout: ['pricing', 'hero'] });
    const w = window as unknown as W;
    expect(w.__sentient_overrides).toEqual({ hero: 'b' });
    expect(w.__sentient_layout_override).toEqual(['pricing', 'hero']);
  });

  it('applyScenario with no layout clears any prior layout override', () => {
    applyScenario({ layout: ['a'] });
    applyScenario({ variants: { x: 'y' } });
    const w = window as unknown as W;
    expect(w.__sentient_layout_override).toBeUndefined();
    expect(w.__sentient_overrides).toEqual({ x: 'y' });
  });

  it('resetScenario clears both globals', () => {
    applyScenario({ variants: { hero: 'b' }, layout: ['a'] });
    resetScenario();
    const w = window as unknown as W;
    expect(w.__sentient_overrides).toBeUndefined();
    expect(w.__sentient_layout_override).toBeUndefined();
  });
});
