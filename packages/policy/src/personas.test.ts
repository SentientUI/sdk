import { describe, expect, it } from 'vitest';
import * as policy from './index';
import { UNKNOWN_PERSONA, UNKNOWN_PERSONA_DISPLAY } from './personas';
import { canonicalPersona } from './vocabulary';

describe('UNKNOWN_PERSONA', () => {
  it('is "unknown", displayed as "Unknown"', () => {
    expect(UNKNOWN_PERSONA).toBe('unknown');
    expect(UNKNOWN_PERSONA_DISPLAY).toBe('Unknown');
  });

  it('the package ships no persona list, display table, or name-keyed layout table', () => {
    // Removed 2026-09-13 with the seeded personas. A persona vocabulary is a
    // property of the customer's project, never of this package.
    for (const name of ['PERSONAS', 'PERSONA_DISPLAY', 'LEGACY_PERSONA_MAP', 'CLUSTER_PRIORITY']) {
      expect(policy).not.toHaveProperty(name);
    }
  });
});

describe('canonicalPersona', () => {
  it('passes any key-shaped label through, normalized', () => {
    expect(canonicalPersona('admin')).toBe('admin');
    expect(canonicalPersona(' Power_User ')).toBe('power_user');
    expect(canonicalPersona('trial-user')).toBe('trial-user');
  });

  it('does not remap plurals — no label is special-cased by name', () => {
    expect(canonicalPersona('admins')).toBe('admins');
  });

  it('returns unknown for null, empty, structural, and non-key-shaped labels', () => {
    expect(canonicalPersona(null)).toBe('unknown');
    expect(canonicalPersona(undefined)).toBe('unknown');
    expect(canonicalPersona('')).toBe('unknown');
    expect(canonicalPersona('unknown')).toBe('unknown');
    expect(canonicalPersona('__all__')).toBe('unknown');
    expect(canonicalPersona('a@b.com')).toBe('unknown');
    expect(canonicalPersona('two words')).toBe('unknown');
  });
});
