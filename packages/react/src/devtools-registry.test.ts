import { describe, expect, it, vi } from 'vitest';
import { registerComponent, getRegistered, subscribeRegistry } from './devtools-registry';

describe('devtools-registry', () => {
  it('registers and lists components, dedupes by id', () => {
    const un1 = registerComponent({ id: 'hero', variantIds: ['a', 'b'], goal: 'signup' });
    const un2 = registerComponent({ id: 'hero', variantIds: ['a', 'b', 'c'] }); // same id re-registers
    expect(getRegistered().filter((c) => c.id === 'hero')).toHaveLength(1);
    expect(getRegistered().find((c) => c.id === 'hero')!.variantIds).toEqual(['a', 'b', 'c']);
    un1(); un2();
  });

  it('unregister removes the component and notifies subscribers', () => {
    const spy = vi.fn();
    const unsub = subscribeRegistry(spy);
    const un = registerComponent({ id: 'cta', variantIds: ['x'] });
    expect(getRegistered().some((c) => c.id === 'cta')).toBe(true);
    un();
    expect(getRegistered().some((c) => c.id === 'cta')).toBe(false);
    expect(spy).toHaveBeenCalled();
    unsub();
  });
});
