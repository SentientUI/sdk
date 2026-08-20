import { describe, expect, it } from 'vitest';
import { goalValueOf } from './adaptive-shared.js';

describe('goalValueOf', () => {
  it('returns the static value from simple goal configs', () => {
    expect(goalValueOf({ type: 'click', value: 40 })).toBe(40);
    expect(goalValueOf({ type: 'form_submit', value: 12.5 })).toBe(12.5);
    expect(goalValueOf({ type: 'scroll_depth', threshold: 0.5, value: 1 })).toBe(1);
  });

  it('returns undefined when no value is declared', () => {
    expect(goalValueOf({ type: 'click' })).toBeUndefined();
    expect(goalValueOf({ type: 'form_submit' })).toBeUndefined();
  });

  it('returns undefined for string goals and composites (spec §9.4)', () => {
    expect(goalValueOf('signup')).toBeUndefined();
    expect(goalValueOf({ type: 'composite', all: [{ type: 'click' }] })).toBeUndefined();
    expect(goalValueOf({ type: 'weighted_composite', steps: [] })).toBeUndefined();
  });
});
