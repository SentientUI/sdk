import { describe, expect, it } from 'vitest';
import { goalValueOf, scrollFireCollapsedThisTask } from './adaptive-shared.js';

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
