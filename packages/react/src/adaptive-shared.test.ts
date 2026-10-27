import { describe, expect, it, vi } from 'vitest';
import { compositeFunnelId, compositeFunnelSteps, goalValueOf, scrollFireCollapsedThisTask } from './adaptive-shared.js';

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

// Two nested Adaptive components sharing one scroll_depth goal label attach two
// SEPARATE IntersectionObservers, and one scroll delivers both callbacks in one
// task — with a microtask checkpoint between them, which is precisely the crack
// core's microtask-closed flush window falls into: the goal double-recorded.
// jsdom has no IntersectionObserver, so the gate is unit-tested directly; the
// contract it must satisfy is "collapse across microtasks within a task,
// release at the next task".
describe('scrollFireCollapsedThisTask', () => {
  it('collapses a same-key re-fire in the same synchronous flush', () => {
    expect(scrollFireCollapsedThisTask('sync-key')).toBe(false);
    expect(scrollFireCollapsedThisTask('sync-key')).toBe(true);
  });

  it('collapses across a microtask checkpoint — the split that double-recorded', async () => {
    expect(scrollFireCollapsedThisTask('checkpoint-key')).toBe(false);
    // Between two UA callback invocations in one task, "clean up after running
    // script" runs a microtask checkpoint. A microtask-scoped window would
    // reopen here; this gate must not.
    await Promise.resolve();
    expect(scrollFireCollapsedThisTask('checkpoint-key')).toBe(true);
  });

  it('never collapses distinct labels', () => {
    expect(scrollFireCollapsedThisTask('label-a')).toBe(false);
    expect(scrollFireCollapsedThisTask('label-b')).toBe(false);
  });

  it('releases the key in a later task — a later genuine fire records', async () => {
    expect(scrollFireCollapsedThisTask('release-key')).toBe(false);
    // A genuinely separate scroll fire arrives in a later rendering-update
    // task; a macrotask boundary must reopen the gate.
    await new Promise((r) => setTimeout(r, 5));
    expect(scrollFireCollapsedThisTask('release-key')).toBe(false);
  });
});

describe('composite → funnel declaration', () => {
  it('derives a stable, server-valid funnel id from the component id', () => {
    expect(compositeFunnelId('hero')).toBe('hero-steps');
    expect(compositeFunnelId('pricing-cta')).toBe('pricing-cta-steps');
    // Lossy slugs carry a hash of the raw id: these two must not share a funnel.
    const a = compositeFunnelId('Hero CTA');
    const b = compositeFunnelId('hero_cta');
    expect(a).not.toBe(b);
    for (const id of [a, b, compositeFunnelId('***'), compositeFunnelId('x'.repeat(300))]) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(id.length).toBeLessThanOrEqual(128);
    }
    expect(compositeFunnelId('Hero CTA')).toBe(a); // deterministic across pages/visits
  });

  it('sends steps the server accepts: clamped weights, no repeats or invalid names, at most 12', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const step = (name: string, weight: number) => ({ name, weight, goal: { type: 'click' as const } });
    expect(compositeFunnelSteps('c', { type: 'weighted_composite', steps: [step('a', 0.2), step('b', 1.5)] }))
      .toEqual([{ goalId: 'a', weight: 0.2 }, { goalId: 'b', weight: 1 }]);
    expect(compositeFunnelSteps('c', { type: 'weighted_composite', steps: [step('a', 0.2), step('a', 0.3), step('b', 1)] }))
      .toEqual([{ goalId: 'a', weight: 0.2 }, { goalId: 'b', weight: 1 }]);
    expect(compositeFunnelSteps('c', {
      type: 'weighted_composite', steps: [step('funnel:x', 0.1), step('x'.repeat(129), 0.2), step('', 0.3), step('ok', 1)],
    })).toEqual([{ goalId: 'ok', weight: 1 }]);
    expect(compositeFunnelSteps('c', {
      type: 'weighted_composite', steps: Array.from({ length: 14 }, (_, i) => step(`s${i}`, 1)),
    })).toHaveLength(12);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('orders steps by weight, so the most valuable step is the completion (composites were never ordered)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const step = (name: string, weight: number) => ({ name, weight, goal: { type: 'click' as const } });
    // Under the summed rule this listed order meant nothing; as a funnel in
    // listed order, view_pricing would have been the full-credit completion.
    expect(compositeFunnelSteps('c', { type: 'weighted_composite', steps: [step('signup', 0.7), step('view_pricing', 0.3)] }))
      .toEqual([{ goalId: 'view_pricing', weight: 0.3 }, { goalId: 'signup', weight: 0.7 }]);
    // Ties keep their listed order.
    expect(compositeFunnelSteps('c', { type: 'weighted_composite', steps: [step('a', 1), step('b', 1)] }).map((s) => s.goalId))
      .toEqual(['a', 'b']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
