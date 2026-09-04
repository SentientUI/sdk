import { describe, expect, it } from 'vitest';
import { toWireSlot, type SlotDeclInput } from './slots.js';

// toWireSlot is the whitelist between whatever an SDK layer decorated a slot
// with and the zod schema on /v1/decide. The schema rejects unknown keys, so a
// leaked property does not "just get ignored" — it fails the whole decide call
// for every slot in the batch. Framework layers routinely hang goal configs,
// refs and callbacks off the declaration object; none of it may travel.
describe('toWireSlot', () => {
  it('strips every non-wire property, keeping only id/arms/dims/baseline', () => {
    const decorated = {
      id: 'hero',
      arms: ['a', 'b'],
      dims: { tone: ['warm', 'cool'] },
      baseline: 'a',
      // The junk an SDK layer plausibly attaches:
      goal: { id: 'signup', weight: 1 },
      onGoal: () => undefined,
      ref: { current: null },
      __internal: 'anything',
    } as unknown as SlotDeclInput;

    const wire = toWireSlot(decorated);
    expect(Object.keys(wire).sort()).toEqual(['arms', 'baseline', 'dims', 'id']);
    expect(wire).toEqual({
      id: 'hero',
      arms: ['a', 'b'],
      dims: { tone: ['warm', 'cool'] },
      baseline: 'a',
    });
  });

  it('omits absent optional fields entirely — never as explicit undefined keys', () => {
    // JSON.stringify drops undefined values, but zod's strict object sees the
    // key itself; and a `dims: undefined` alongside `arms` would trip the
    // exactly-one-of-arms|dims validation.
    const wire = toWireSlot({ id: 'cta', arms: ['x'] });
    expect(Object.keys(wire).sort()).toEqual(['arms', 'id']);
    expect('dims' in wire).toBe(false);
    expect('baseline' in wire).toBe(false);
  });

  it('copies arms and dims arrays rather than aliasing the caller’s (readonly) ones', () => {
    // `dims` accepts `as const` readonly arrays; the wire type needs mutable
    // ones, and sharing the reference would let a later queue-side mutation
    // reach back into the caller's declaration object.
    const arms = ['a', 'b'];
    const tones = ['warm', 'cool'] as const;
    const wire = toWireSlot({ id: 'hero', arms, dims: { tone: tones } });
    expect(wire.arms).not.toBe(arms);
    expect(wire.arms).toEqual(arms);
    expect(wire.dims!.tone).not.toBe(tones);
    expect(wire.dims!.tone).toEqual([...tones]);
  });

  it('keeps a per-dim baseline object intact', () => {
    const wire = toWireSlot({
      id: 'hero',
      dims: { tone: ['warm', 'cool'], size: ['sm', 'lg'] },
      baseline: { tone: 'warm', size: 'sm' },
    });
    expect(wire.baseline).toEqual({ tone: 'warm', size: 'sm' });
  });
});
