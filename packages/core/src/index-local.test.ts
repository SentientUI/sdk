import { describe, it, expect } from 'vitest';
import {
  createLocalEngine,
  inferSectionTypes,
  LOCAL_ENGINE_AVAILABLE,
  LOCAL_ENGINE_SENTINEL,
} from './index-local.js';
import * as stub from './index-local-stub.js';
import { pickDeterministicArm } from '@sentientui/policy';

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

  it('unforced persona is unknown for every session, with confidence 0.5', () => {
    // Was a hash of the session onto the four seeded personas, removed
    // 2026-09-13: nothing declared means nothing known.
    for (const sid of [SID, 'another-session', 'third']) {
      const out = createLocalEngine({ sessionId: sid }).decide({});
      expect(out.persona).toBe('unknown');
      expect(out.confidence).toBe(0.5);
    }
  });

  it('unforced keyless mode previews the authored layout', () => {
    expect(createLocalEngine({ sessionId: SID }).decide(INPUT).layoutOrder).toEqual(INPUT.sections);
  });

  it('forcedPersona wins for any well-formed key; a malformed one falls back to unknown', () => {
    // Projects declare their own vocabulary now, so `admin` must preview as
    // `admin` — it used to hash to a seeded persona.
    expect(createLocalEngine({ sessionId: SID, forcedPersona: 'admin' }).decide({}).persona).toBe('admin');
    expect(createLocalEngine({ sessionId: SID, forcedPersona: 'unknown' }).decide({}).persona).toBe('unknown');
    expect(createLocalEngine({ sessionId: SID, forcedPersona: 'not a key!' }).decide({}).persona).toBe('unknown');
  });
});

describe('createLocalEngine — layout', () => {
  it('gives every persona key an arrangement, not just four magic strings', () => {
    // Rewritten 2026-09-13. This used to assert the specific orderings two of
    // the seeded personas produced, because the local
    // engine looked keys up in a four-persona table — so every OTHER key
    // silently no-oped while the CLI and docs told people to try their own.
    // The engine now maps any key onto an archetype, which is what preview mode
    // was always documented to do.
    const order = (persona: string) =>
      createLocalEngine({ sessionId: SID, forcedPersona: persona }).decide(INPUT).layoutOrder;
    for (const key of ['evaluator', 'trial_user', 'admin', 'trial', 'wombat']) {
      expect([...order(key)!].sort()).toEqual(['faq', 'hero', 'pricing']);
    }
    // Different keys must be able to differ, or preview mode shows nothing.
    // (Only some do on a 3-section page — there are few distinct orders.) The
    // earlier pinned `admin` order was really the hashed fallback persona's:
    // resolvePersona discarded every non-seeded key before it got here.
    const keys = ['admin', 'evaluator', 'a', 'b', 'trial', 'wombat'];
    expect(new Set(keys.map((k) => JSON.stringify(order(k)))).size).toBeGreaterThan(1);
  });

  it('leaves the authored order alone for an unidentified visitor', () => {
    expect(createLocalEngine({ sessionId: SID, forcedPersona: 'unknown' }).decide(INPUT).layoutOrder)
      .toEqual(INPUT.sections);
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
    const out = createLocalEngine({ sessionId: SID, forcedPersona: 'admin' }).decide(INPUT);
    expect(out.slots.hero).toEqual({
      tone: pickDeterministicArm(`${SID}:admin`, 'hero.tone', ['calm', 'urgent']),
    });
    // Verified concrete values for the e2e fixture (Task 4.6 depends on these):
    expect(out.slots.hero).toEqual({ tone: 'calm' });
    const res = createLocalEngine({ sessionId: SID, forcedPersona: 'trial_user' }).decide(INPUT);
    expect(res.slots.hero).toEqual({ tone: 'urgent' });
  });

  it('enumerated slots pick via the persona-salted key', () => {
    const out = createLocalEngine({ sessionId: SID, forcedPersona: 'admin' }).decide(INPUT);
    expect(out.slots['pricing-area']).toBe(
      pickDeterministicArm(`${SID}:admin`, 'pricing-area', ['standard', 'social_first']),
    );
    expect(out.slots['pricing-area']).toBe('social_first'); // verified concrete value
  });

  it('assignments are persona-independent: pickDeterministicArm(sessionId, componentId, variantIds)', () => {
    const admin = createLocalEngine({ sessionId: SID, forcedPersona: 'admin' }).decide(INPUT);
    const evaluator = createLocalEngine({ sessionId: SID, forcedPersona: 'evaluator' }).decide(INPUT);
    const expected = pickDeterministicArm(SID, 'hero_cta', ['a', 'b']);
    expect(admin.assignments.hero_cta).toBe(expected);
    expect(evaluator.assignments.hero_cta).toBe(expected);
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
