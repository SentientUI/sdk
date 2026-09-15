import { describe, expect, it } from 'vitest';
import {
  LAYOUT_ARCHETYPES,
  LAYOUT_ARCHETYPE_NAMES,
  orderByArchetype,
  previewOrderForPersona,
  candidateLayouts,
} from './layout-heuristics';
import { hashLayout } from './hash';

describe('LAYOUT_ARCHETYPES', () => {
  it('is a catalogue of orderings, not a persona taxonomy', () => {
    // The point of the 2026-09-13 rename. If these keys ever become persona
    // names again, the arm space starts depending on what a customer called
    // their audience — see the candidateLayouts tests below for why that broke.
    expect([...LAYOUT_ARCHETYPE_NAMES].sort()).toEqual(
      ['conversion_led', 'discovery_led', 'evidence_led', 'price_led'],
    );
    for (const name of LAYOUT_ARCHETYPE_NAMES) {
      expect(LAYOUT_ARCHETYPES[name]).toBeTruthy();
    }
  });

  it('every archetype ranks generic, so an unknown type has somewhere to land', () => {
    for (const name of LAYOUT_ARCHETYPE_NAMES) {
      expect(LAYOUT_ARCHETYPES[name]).toContain('generic');
    }
  });
});

describe('orderByArchetype', () => {
  const sections = ['hero', 'features', 'pricing'];
  const types = new Map([
    ['hero', 'hero'],
    ['features', 'features'],
    ['pricing', 'pricing'],
  ]);

  it('puts pricing first for conversion_led', () => {
    expect(orderByArchetype(sections, types, 'conversion_led')[0]).toBe('pricing');
  });

  it('puts features first for evidence_led', () => {
    expect(orderByArchetype(['pricing', 'hero', 'features'], types, 'evidence_led')[0]).toBe('features');
  });

  it('treats sections with no graph entry as generic', () => {
    const thin = new Map([
      ['hero', 'hero'],
      ['pricing', 'pricing'],
    ]);
    const result = orderByArchetype(['hero', 'mystery', 'pricing'], thin, 'conversion_led');
    expect(result).toContain('mystery');
    expect(result).toHaveLength(3);
  });

  it('does not mutate the input array', () => {
    const input = ['hero', 'features', 'pricing'];
    orderByArchetype(input, types, 'conversion_led');
    expect(input).toEqual(['hero', 'features', 'pricing']);
  });

  it('pins structural sections at their original index (phase 2d)', () => {
    // 'navigation' ranks near LAST in every archetype, so without the pin the
    // navbar would sort to the bottom of the page — the visible damage the role
    // projection exists to prevent.
    const secs = ['nav', 'hero', 'pricing', 'footer'];
    const t = new Map([
      ['nav', 'navigation'],
      ['hero', 'hero'],
      ['pricing', 'pricing'],
      ['footer', 'navigation'],
    ]);
    const roles = new Map<string, 'converter' | 'persuader' | 'structural'>([
      ['nav', 'structural'],
      ['hero', 'converter'],
      ['pricing', 'converter'],
      ['footer', 'structural'],
    ]);
    const result = orderByArchetype(secs, t, 'conversion_led', roles);
    expect(result[0]).toBe('nav');
    expect(result[3]).toBe('footer');
    expect(result).toEqual(['nav', 'pricing', 'hero', 'footer']);
  });

  it('with a roles map but no structural sections matches the role-less order', () => {
    const roles = new Map<string, 'converter' | 'persuader' | 'structural'>([
      ['hero', 'converter'],
      ['features', 'persuader'],
      ['pricing', 'converter'],
    ]);
    expect(orderByArchetype(sections, types, 'conversion_led', roles)).toEqual(
      orderByArchetype(sections, types, 'conversion_led'),
    );
  });

  it('sorts a present-but-off-vocabulary type LAST, not first (no top-of-page hijack)', () => {
    // 'newsletter' is in no archetype priority list. It must fall to generic's
    // rank (last), never indexOf===-1 which would sort it ahead of pricing.
    const withOffVocab = new Map([
      ['newsletter', 'newsletter'],
      ['hero', 'hero'],
      ['pricing', 'pricing'],
    ]);
    const result = orderByArchetype(['newsletter', 'hero', 'pricing'], withOffVocab, 'conversion_led');
    expect(result[0]).toBe('pricing');
    expect(result[result.length - 1]).toBe('newsletter');
  });
});

describe('previewOrderForPersona — keyless local mode only', () => {
  const sections = ['hero', 'features', 'pricing'];
  const types = new Map([
    ['hero', 'hero'],
    ['features', 'features'],
    ['pricing', 'pricing'],
  ]);

  it('returns the input order unchanged for unknown', () => {
    expect(previewOrderForPersona(sections, types, 'unknown')).toEqual(sections);
    expect(previewOrderForPersona(sections, types, '')).toEqual(sections);
  });

  it('gives ANY key an arrangement, not just four magic strings', () => {
    // The old behaviour silently no-oped for every key except the four seeded
    // personas, so `?sentient_persona=admin` did nothing while the docs said it
    // would. Now every key maps onto some archetype.
    for (const key of ['admin', 'trial', 'wombat', 'zz-9']) {
      expect(previewOrderForPersona(sections, types, key)).toHaveLength(3);
    }
    const distinct = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((k) => previewOrderForPersona(sections, types, k).join('>')),
    );
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('is deterministic for a given key', () => {
    expect(previewOrderForPersona(sections, types, 'admin')).toEqual(
      previewOrderForPersona(sections, types, 'admin'),
    );
  });
});

const SECTIONS = ['hero', 'features', 'pricing', 'comparison'];
const TYPES = new Map([
  ['hero', 'hero'],
  ['features', 'features'],
  ['pricing', 'pricing'],
  ['comparison', 'comparison'],
]);

describe('candidateLayouts', () => {
  it('includes every distinct archetype ordering as a candidate arm', () => {
    expect(candidateLayouts(SECTIONS, TYPES).size).toBeGreaterThan(1);
  });

  it('keys candidates by the same hash the worker credits', () => {
    for (const [hash, order] of candidateLayouts(SECTIONS, TYPES)) {
      expect(hash).toBe(hashLayout(order));
    }
  });

  it('ALWAYS contains the authored order — it is the control arm', () => {
    // The regression this file now guards. The authored order used to be a
    // candidate only when the requesting persona's name missed the archetype
    // table; a project that declared a seeded persona name had its own page order excluded
    // from the arm space entirely, so the bandit was structurally obliged to
    // reorder and nothing could ever mean "leave it alone".
    const authored = ['social_proof', 'pricing', 'faq', 'hero'];
    const t = new Map([
      ['social_proof', 'social_proof'],
      ['pricing', 'pricing'],
      ['faq', 'faq'],
      ['hero', 'hero'],
    ]);
    expect([...candidateLayouts(authored, t).values()]).toContainEqual(authored);
    expect([...candidateLayouts(SECTIONS, TYPES).values()]).toContainEqual(SECTIONS);
  });

  it('does not depend on any persona — the arm space is a property of the PAGE', () => {
    // There is no persona parameter any more, which is the structural
    // guarantee. This pins the consequence: one page, one arm space.
    const a = [...candidateLayouts(SECTIONS, TYPES).keys()].sort();
    const b = [...candidateLayouts([...SECTIONS], new Map(TYPES)).keys()].sort();
    expect(a).toEqual(b);
  });

  it('does not hand back a reference to the caller array', () => {
    const authored = [...SECTIONS];
    const got = candidateLayouts(authored, TYPES).get(hashLayout(authored))!;
    got.push('injected');
    expect(authored).toEqual(SECTIONS);
  });

  it('pins structural sections across EVERY candidate (phase 2d)', () => {
    const secs = ['nav', ...SECTIONS, 'footer'];
    const t = new Map([...TYPES, ['nav', 'navigation'], ['footer', 'navigation']]);
    const roles = new Map<string, 'converter' | 'persuader' | 'structural'>([
      ['nav', 'structural'],
      ['footer', 'structural'],
    ]);
    const candidates = candidateLayouts(secs, t, roles);
    expect(candidates.size).toBeGreaterThan(1);
    for (const order of candidates.values()) {
      expect(order[0]).toBe('nav');
      expect(order[order.length - 1]).toBe('footer');
    }
  });
});
