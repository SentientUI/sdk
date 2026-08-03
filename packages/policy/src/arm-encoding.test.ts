import { describe, expect, it } from 'vitest';
import {
  canonicalArm,
  parseArm,
  marginalArmKey,
  slotBaselineArm,
  validateSlotDecl,
  slotResultFor,
  type SlotDecl,
} from './arm-encoding';

describe('canonicalArm', () => {
  it('encodes sorted dim=value pairs joined with |', () => {
    expect(canonicalArm({ tone: 'calm', motion: 'none' })).toBe('motion=none|tone=calm');
  });

  it('is insensitive to key insertion order', () => {
    expect(canonicalArm({ motion: 'none', tone: 'calm' })).toBe(canonicalArm({ tone: 'calm', motion: 'none' }));
  });

  it('handles a single dim and an empty record', () => {
    expect(canonicalArm({ tone: 'urgent' })).toBe('tone=urgent');
    expect(canonicalArm({})).toBe('');
  });
});

describe('parseArm', () => {
  it('round-trips canonicalArm output', () => {
    const values = { motion: 'pulse', tone: 'urgent' };
    expect(parseArm(canonicalArm(values))).toEqual(values);
  });

  it('parses a single-dim arm', () => {
    expect(parseArm('tone=calm')).toEqual({ tone: 'calm' });
  });

  it('returns null for enumerated (non-dims) arms and malformed input', () => {
    expect(parseArm('urgent')).toBeNull();
    expect(parseArm('')).toBeNull();
    expect(parseArm('=calm')).toBeNull();
    expect(parseArm('tone=')).toBeNull();
    expect(parseArm('a=b=c')).toBeNull();
    expect(parseArm('tone=calm|urgent')).toBeNull();
  });

  it('returns null when the same dim appears twice', () => {
    expect(parseArm('tone=calm|tone=urgent')).toBeNull();
  });
});

describe('marginalArmKey', () => {
  it('formats dim=value', () => {
    expect(marginalArmKey('tone', 'calm')).toBe('tone=calm');
  });
});

describe('slotBaselineArm', () => {
  it('defaults to the first declared arm for arms slots', () => {
    expect(slotBaselineArm({ id: 's', arms: ['calm', 'urgent'] })).toBe('calm');
  });

  it('uses the declared string baseline for arms slots', () => {
    expect(slotBaselineArm({ id: 's', arms: ['calm', 'urgent'], baseline: 'urgent' })).toBe('urgent');
  });

  it('defaults to the first value per dim (canonical encoding) for dims slots', () => {
    const decl: SlotDecl = { id: 's', dims: { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] } };
    expect(slotBaselineArm(decl)).toBe('motion=none|tone=calm');
  });

  it('canonicalizes a declared record baseline for dims slots', () => {
    const decl: SlotDecl = {
      id: 's',
      dims: { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] },
      baseline: { tone: 'urgent', motion: 'none' },
    };
    expect(slotBaselineArm(decl)).toBe('motion=none|tone=urgent');
  });
});

describe('validateSlotDecl', () => {
  const okArms: SlotDecl = { id: 's', arms: ['a', 'b'] };
  const okDims: SlotDecl = { id: 's', dims: { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] } };

  it('accepts a valid arms slot and a valid dims slot', () => {
    expect(validateSlotDecl(okArms)).toEqual({ ok: true });
    expect(validateSlotDecl(okDims)).toEqual({ ok: true });
  });

  it('rejects arms and dims both set', () => {
    const r = validateSlotDecl({ id: 's', arms: ['a', 'b'], dims: { tone: ['x', 'y'] } });
    expect(r.ok).toBe(false);
  });

  it('rejects neither arms nor dims', () => {
    expect(validateSlotDecl({ id: 's' }).ok).toBe(false);
  });

  it('rejects fewer than 2 arms and more than 12 arms', () => {
    expect(validateSlotDecl({ id: 's', arms: ['solo'] }).ok).toBe(false);
    expect(validateSlotDecl({ id: 's', arms: Array.from({ length: 13 }, (_, i) => `a${i}`) }).ok).toBe(false);
  });

  it('rejects duplicate arm ids', () => {
    expect(validateSlotDecl({ id: 's', arms: ['a', 'a'] }).ok).toBe(false);
  });

  it('rejects an arms baseline outside the declared arms', () => {
    expect(validateSlotDecl({ id: 's', arms: ['a', 'b'], baseline: 'c' }).ok).toBe(false);
  });

  it('rejects more than 4 dims, and dims with <2 or >6 values', () => {
    expect(
      validateSlotDecl({
        id: 's',
        dims: { a: ['1', '2'], b: ['1', '2'], c: ['1', '2'], d: ['1', '2'], e: ['1', '2'] },
      }).ok,
    ).toBe(false);
    expect(validateSlotDecl({ id: 's', dims: { tone: ['only'] } }).ok).toBe(false);
    expect(validateSlotDecl({ id: 's', dims: { tone: ['1', '2', '3', '4', '5', '6', '7'] } }).ok).toBe(false);
  });

  it('rejects a declared product above 64 and accepts exactly 64', () => {
    // 6 * 6 * 2 = 72 > 64
    expect(
      validateSlotDecl({
        id: 's',
        dims: { a: ['1', '2', '3', '4', '5', '6'], b: ['1', '2', '3', '4', '5', '6'], c: ['1', '2'] },
      }).ok,
    ).toBe(false);
    // 4 * 4 * 4 = 64 — allowed
    expect(
      validateSlotDecl({
        id: 's',
        dims: { a: ['1', '2', '3', '4'], b: ['1', '2', '3', '4'], c: ['1', '2', '3', '4'] },
      }).ok,
    ).toBe(true);
  });

  it('rejects a dims baseline that misses a dim or uses an undeclared value', () => {
    expect(
      validateSlotDecl({
        id: 's',
        dims: { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] },
        baseline: { tone: 'calm' },
      }).ok,
    ).toBe(false);
    expect(
      validateSlotDecl({
        id: 's',
        dims: { tone: ['calm', 'urgent'] },
        baseline: { tone: 'shouty' },
      }).ok,
    ).toBe(false);
  });

  it('rejects a string baseline on a dims slot and a record baseline on an arms slot', () => {
    expect(validateSlotDecl({ id: 's', dims: { tone: ['calm', 'urgent'] }, baseline: 'calm' }).ok).toBe(false);
    expect(validateSlotDecl({ id: 's', arms: ['a', 'b'], baseline: { tone: 'calm' } }).ok).toBe(false);
  });

  it("rejects '=' in an enumerated arm id (reserved for dims encoding, prevents parseArm misclassification)", () => {
    const r = validateSlotDecl({ id: 's', arms: ['size=large', 'b'] });
    expect(r.ok).toBe(false);
    // A valid enumerated arm without '=' still passes.
    expect(validateSlotDecl({ id: 's', arms: ['large', 'small'] }).ok).toBe(true);
  });
});

describe('slotResultFor', () => {
  it('returns the arm id verbatim for arms slots', () => {
    expect(slotResultFor({ id: 's', arms: ['a', 'b'] }, 'b')).toBe('b');
  });

  it('returns the parsed record for dims slots', () => {
    const decl: SlotDecl = { id: 's', dims: { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] } };
    expect(slotResultFor(decl, 'motion=pulse|tone=urgent')).toEqual({ motion: 'pulse', tone: 'urgent' });
  });

  it('falls back to the baseline record when a dims arm fails to parse', () => {
    const decl: SlotDecl = { id: 's', dims: { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] } };
    expect(slotResultFor(decl, 'garbage')).toEqual({ motion: 'none', tone: 'calm' });
  });
});
