import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  subscribe,
  update,
  getWeights,
  _resetWeightsStore,
  type ComponentWeights,
} from './weights-store.js';

function weights(componentId: string, updatedAt = 1): ComponentWeights {
  return { componentId, updatedAt, variants: [{ variantId: 'a', pulls: 3, avgReward: 0.5 }] };
}

beforeEach(() => {
  _resetWeightsStore();
});

describe('weights-store', () => {
  it('returns null for a component never seen', () => {
    expect(getWeights('hero')).toBeNull();
  });

  it('stores and returns the latest weights for a component', () => {
    update('hero', weights('hero', 10));
    expect(getWeights('hero')?.updatedAt).toBe(10);
  });

  it('notifies a subscriber when its component updates', () => {
    const cb = vi.fn();
    subscribe('hero', cb);
    const w = weights('hero');
    update('hero', w);
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(w);
  });

  it('isolates subscriptions — a component update never notifies another component listener', () => {
    const heroCb = vi.fn();
    const ctaCb = vi.fn();
    subscribe('hero', heroCb);
    subscribe('cta', ctaCb);
    update('hero', weights('hero'));
    expect(heroCb).toHaveBeenCalledOnce();
    expect(ctaCb).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', () => {
    const cb = vi.fn();
    const unsub = subscribe('hero', cb);
    unsub();
    update('hero', weights('hero'));
    expect(cb).not.toHaveBeenCalled();
  });

  it('keeps notifying other listeners when one throws', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    subscribe('hero', bad);
    subscribe('hero', good);
    expect(() => update('hero', weights('hero'))).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });

  it('notifies every listener even when multiple throw in sequence, store stays consistent', () => {
    const order: string[] = [];
    const bad1 = vi.fn(() => {
      order.push('bad1');
      throw new Error('boom1');
    });
    const good = vi.fn(() => {
      order.push('good');
    });
    const bad2 = vi.fn(() => {
      order.push('bad2');
      throw new Error('boom2');
    });
    subscribe('hero', bad1);
    subscribe('hero', good);
    subscribe('hero', bad2);

    const w = weights('hero', 42);
    expect(() => update('hero', w)).not.toThrow();

    // All three listeners were invoked despite two throwing.
    expect(bad1).toHaveBeenCalledOnce();
    expect(good).toHaveBeenCalledOnce();
    expect(bad2).toHaveBeenCalledOnce();
    // Insertion order preserved across the throws.
    expect(order).toEqual(['bad1', 'good', 'bad2']);
    // The thrown listeners did not corrupt the stored value.
    expect(getWeights('hero')).toEqual(w);
    expect(getWeights('hero')?.updatedAt).toBe(42);

    // A subsequent update still reaches all listeners.
    const w2 = weights('hero', 43);
    expect(() => update('hero', w2)).not.toThrow();
    expect(good).toHaveBeenCalledTimes(2);
    expect(getWeights('hero')?.updatedAt).toBe(43);
  });

  it('_resetWeightsStore wipes stored weights and listeners', () => {
    const cb = vi.fn();
    subscribe('hero', cb);
    update('hero', weights('hero'));
    _resetWeightsStore();
    expect(getWeights('hero')).toBeNull();
    update('hero', weights('hero')); // listener was cleared
    expect(cb).toHaveBeenCalledOnce(); // only the pre-reset call
  });
});
