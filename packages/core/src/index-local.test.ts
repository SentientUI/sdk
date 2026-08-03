import { describe, it, expect } from 'vitest';
import {
  createLocalEngine,
  inferSectionTypes,
  LOCAL_ENGINE_AVAILABLE,
  LOCAL_ENGINE_SENTINEL,
} from './index-local.js';
import * as stub from './index-local-stub.js';
import { PERSONAS, fnv1a, pickDeterministicArm } from '@sentientui/policy';

const SID = 'e2e-keyless-session';
const INPUT = {
  sections: ['hero', 'pricing', 'faq'],
  components: [{ id: 'hero_cta', variantIds: ['a', 'b'] }],
  slots: [
    { id: 'hero', dims: { tone: ['calm', 'urgent'] as const } },
    { id: 'pricing-area', arms: ['standard', 'social_first'] },
  ],
};

describe('createLocalEngine — determinism', () => {
  it('same sessionId → identical outcome across calls and instances', () => {
    const a = createLocalEngine({ sessionId: SID }).decide(INPUT);
    const b = createLocalEngine({ sessionId: SID }).decide(INPUT);
    const engine = createLocalEngine({ sessionId: SID });
    expect(a).toEqual(b);
    expect(engine.decide(INPUT)).toEqual(engine.decide(INPUT));
  });

  it('persona = PERSONAS[fnv1a(sessionId) % 4] with confidence 0.5', () => {
    for (const sid of [SID, 'another-session', 'third']) {
      const out = createLocalEngine({ sessionId: sid }).decide({});
      expect(out.persona).toBe(PERSONAS[fnv1a(sid) % PERSONAS.length]);
      expect(out.confidence).toBe(0.5);
    }
    // Pinned value for the e2e fixture session (verified against holdout.ts's fnv1a):
    expect(createLocalEngine({ sessionId: SID }).decide({}).persona).toBe('browser');
  });

  it('forcedPersona wins; an invalid forced persona falls back to the hash', () => {
    expect(createLocalEngine({ sessionId: SID, forcedPersona: 'researcher' }).decide({}).persona).toBe('researcher');
    expect(createLocalEngine({ sessionId: SID, forcedPersona: 'unknown' }).decide({}).persona).toBe('unknown');
    expect(createLocalEngine({ sessionId: SID, forcedPersona: 'martian' }).decide({}).persona).toBe('browser');
  });
});

describe('createLocalEngine — layout', () => {
  it('orders sections via applyClusterHeuristic over inferred section types', () => {
    const buyer = createLocalEngine({ sessionId: SID, forcedPersona: 'buyer' }).decide(INPUT);
    const researcher = createLocalEngine({ sessionId: SID, forcedPersona: 'researcher' }).decide(INPUT);
    // buyer priority: pricing < cta < hero < … < faq; researcher: … faq < hero < … pricing
    expect(buyer.layoutOrder).toEqual(['pricing', 'hero', 'faq']);
    expect(researcher.layoutOrder).toEqual(['faq', 'hero', 'pricing']);
  });

  it('layoutOrder is null when no sections are declared', () => {
    expect(createLocalEngine({ sessionId: SID }).decide({ slots: INPUT.slots }).layoutOrder).toBeNull();
  });
});

describe('inferSectionTypes', () => {
  it('maps id substrings to section types (first rule wins)', () => {
    const types = inferSectionTypes([
      'main-pricing', 'hero-cta', 'faq-block', 'signup-cta', 'trust-badges',
      'social-wall', 'customer-testimonials', 'feature-grid', 'compare-plans',
      'top-nav', 'mystery-section',
    ]);
    expect(types.get('main-pricing')).toBe('pricing');
    expect(types.get('hero-cta')).toBe('hero'); // 'hero' rule precedes 'cta'
    expect(types.get('faq-block')).toBe('faq');
    expect(types.get('signup-cta')).toBe('cta');
    expect(types.get('trust-badges')).toBe('trust');
    expect(types.get('social-wall')).toBe('social_proof');
    expect(types.get('customer-testimonials')).toBe('social_proof');
    expect(types.get('feature-grid')).toBe('features');
    expect(types.get('compare-plans')).toBe('comparison');
    expect(types.get('top-nav')).toBe('navigation');
    expect(types.get('mystery-section')).toBe('generic');
  });
});

describe('createLocalEngine — slots and assignments', () => {
  it('dims slots pick per dim with the persona-salted key', () => {
    const out = createLocalEngine({ sessionId: SID, forcedPersona: 'buyer' }).decide(INPUT);
    expect(out.slots.hero).toEqual({
      tone: pickDeterministicArm(`${SID}:buyer`, 'hero.tone', ['calm', 'urgent']),
    });
    // Verified concrete values for the e2e fixture (Task 4.6 depends on these):
    expect(out.slots.hero).toEqual({ tone: 'calm' });
    const res = createLocalEngine({ sessionId: SID, forcedPersona: 'researcher' }).decide(INPUT);
    expect(res.slots.hero).toEqual({ tone: 'urgent' });
  });

  it('enumerated slots pick via the persona-salted key', () => {
    const out = createLocalEngine({ sessionId: SID, forcedPersona: 'buyer' }).decide(INPUT);
    expect(out.slots['pricing-area']).toBe(
      pickDeterministicArm(`${SID}:buyer`, 'pricing-area', ['standard', 'social_first']),
    );
    expect(out.slots['pricing-area']).toBe('social_first'); // verified concrete value
  });

  it('assignments are persona-independent: pickDeterministicArm(sessionId, componentId, variantIds)', () => {
    const buyer = createLocalEngine({ sessionId: SID, forcedPersona: 'buyer' }).decide(INPUT);
    const researcher = createLocalEngine({ sessionId: SID, forcedPersona: 'researcher' }).decide(INPUT);
    const expected = pickDeterministicArm(SID, 'hero_cta', ['a', 'b']);
    expect(buyer.assignments.hero_cta).toBe(expected);
    expect(researcher.assignments.hero_cta).toBe(expected);
  });
});

describe('module markers and production stub', () => {
  it('engine module: LOCAL_ENGINE_AVAILABLE true and sentinel exported', () => {
    expect(LOCAL_ENGINE_AVAILABLE).toBe(true);
    expect(LOCAL_ENGINE_SENTINEL).toBe('SENTIENT_LOCAL_ENGINE');
  });

  it('stub module: LOCAL_ENGINE_AVAILABLE false, createLocalEngine throws', () => {
    expect(stub.LOCAL_ENGINE_AVAILABLE).toBe(false);
    expect(() => stub.createLocalEngine({ sessionId: 'x' })).toThrow(/not available in production/);
  });
});
