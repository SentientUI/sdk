import { describe, expect, it } from 'vitest';
import {
  PERSONAS,
  UNKNOWN_PERSONA,
  PERSONA_DISPLAY,
  LEGACY_PERSONA_MAP,
  canonicalPersona,
} from './personas';

describe('PERSONAS', () => {
  it('is the pinned canonical vocabulary, in order', () => {
    expect(PERSONAS).toEqual(['buyer', 'researcher', 'deal_seeker', 'browser']);
  });

  it('UNKNOWN_PERSONA is "unknown" and is not a learnable persona', () => {
    expect(UNKNOWN_PERSONA).toBe('unknown');
    expect(PERSONAS as readonly string[]).not.toContain('unknown');
  });
});

describe('PERSONA_DISPLAY', () => {
  it('has the pinned display name for every persona key', () => {
    expect(PERSONA_DISPLAY).toEqual({
      buyer: 'Buyer',
      researcher: 'Researcher',
      deal_seeker: 'Deal seeker',
      browser: 'Browser',
      unknown: 'Unknown',
    });
  });
});

describe('canonicalPersona', () => {
  it('maps legacy plural/hyphen labels to canonical personas', () => {
    expect(canonicalPersona('buyers')).toBe('buyer');
    expect(canonicalPersona('researchers')).toBe('researcher');
    expect(canonicalPersona('deal-seekers')).toBe('deal_seeker');
    expect(canonicalPersona('browsers')).toBe('browser');
  });

  it('is the identity on canonical labels', () => {
    for (const p of PERSONAS) expect(canonicalPersona(p)).toBe(p);
  });

  it('returns unknown for null, undefined, empty, and unrecognized labels', () => {
    expect(canonicalPersona(null)).toBe('unknown');
    expect(canonicalPersona(undefined)).toBe('unknown');
    expect(canonicalPersona('')).toBe('unknown');
    expect(canonicalPersona('unknown')).toBe('unknown');
    expect(canonicalPersona('power-user')).toBe('unknown');
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(canonicalPersona(' Buyers ')).toBe('buyer');
    expect(canonicalPersona('Deal_Seeker')).toBe('deal_seeker');
  });

  it('LEGACY_PERSONA_MAP includes identity mappings for all canonical personas', () => {
    for (const p of PERSONAS) expect(LEGACY_PERSONA_MAP[p]).toBe(p);
  });
});
