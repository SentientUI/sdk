import { describe, expect, it } from 'vitest';
import * as resolvePersonaModule from './vocabulary';
import {
  DEFAULT_PERSONA_VOCABULARY,
  PERSONA_KEY_RE,
  RESERVED_PERSONA_KEYS,
  resolvePersona,
  type PersonaVocabularyMember,
} from './vocabulary';
import { PERSONAS, PERSONA_DISPLAY } from './personas';

describe('PERSONA_KEY_RE', () => {
  it('accepts slug keys up to 32 chars', () => {
    for (const k of ['admin', 'deal_seeker', 'a', 'gift-hunter', 'x'.repeat(32)]) {
      expect(k).toMatch(PERSONA_KEY_RE);
    }
  });

  it('rejects uppercase, spaces, emails, leading separators, empties, overlong', () => {
    for (const k of ['Admin', 'admin user', 'a@b.com', '-admin', '_admin', '', 'x'.repeat(33)]) {
      expect(k).not.toMatch(PERSONA_KEY_RE);
    }
  });
});

describe('RESERVED_PERSONA_KEYS', () => {
  it('reserves the structural keys and the legacy plural labels', () => {
    expect(RESERVED_PERSONA_KEYS).toEqual([
      'unknown',
      '__all__',
      'buyers',
      'researchers',
      'deal-seekers',
      'browsers',
    ]);
  });
});

describe('DEFAULT_PERSONA_VOCABULARY', () => {
  it('is the pinned four with their pinned display names', () => {
    expect(DEFAULT_PERSONA_VOCABULARY.map((m) => m.key)).toEqual([...PERSONAS]);
    for (const m of DEFAULT_PERSONA_VOCABULARY) {
      expect(m.displayName).toBe(PERSONA_DISPLAY[m.key as (typeof PERSONAS)[number]]);
    }
  });
});

const SAAS: readonly PersonaVocabularyMember[] = [
  { key: 'admin', displayName: 'Admin' },
  { key: 'evaluator', displayName: 'Evaluator' },
];

describe('resolvePersona — declared path', () => {
  it('serves a declared member at confidence 1 regardless of inferred state', () => {
    expect(
      resolvePersona({ declared: 'admin', clusterLabel: 'buyer', inferredConfidence: 0.9 }, SAAS),
    ).toEqual({ persona: 'admin', source: 'declared', confidence: 1 });
  });

  it('normalizes case and whitespace before matching', () => {
    expect(resolvePersona({ declared: '  Admin ' }, SAAS).persona).toBe('admin');
  });

  it('resolves an alias to its member key', () => {
    const vocab = [{ key: 'purchaser', displayName: 'Purchaser', aliases: ['buyer'] }];
    expect(resolvePersona({ declared: 'buyer' }, vocab)).toEqual({
      persona: 'purchaser',
      source: 'declared',
      confidence: 1,
    });
  });

  it('resolves a legacy plural label iff its canonical form is a member', () => {
    expect(resolvePersona({ declared: 'buyers' }).persona).toBe('buyer');
    expect(resolvePersona({ declared: 'buyers' }, SAAS).persona).toBe('unknown');
  });

  it('routes a legacy plural through a rename alias', () => {
    const vocab = [{ key: 'purchaser', displayName: 'Purchaser', aliases: ['buyer'] }];
    expect(resolvePersona({ declared: 'buyers' }, vocab).persona).toBe('purchaser');
  });

  it('an empty/whitespace declared value is absent, not unrecognized', () => {
    const r = resolvePersona({ declared: '   ' }, SAAS);
    expect(r.source).toBe('none');
    expect(r.unrecognizedDeclared).toBeUndefined();
  });
});

describe('resolvePersona — unrecognized declared', () => {
  it('falls through byte-identically to the undeclared resolution', () => {
    const declared = resolvePersona(
      { declared: 'staff', clusterLabel: 'researcher', inferredConfidence: 0.6 },
      SAAS,
    );
    const undeclared = resolvePersona({ clusterLabel: 'researcher', inferredConfidence: 0.6 }, SAAS);
    const { unrecognizedDeclared, ...rest } = declared;
    expect(rest).toEqual(undeclared);
    expect(unrecognizedDeclared).toBe('staff');
  });

  it('reports the normalized value, truncated past 64 chars', () => {
    const junk = 'X'.repeat(100);
    const r = resolvePersona({ declared: junk }, SAAS);
    expect(r.unrecognizedDeclared).toBe('x'.repeat(64));
  });

  it('a retired member no longer resolves, directly or via its aliases', () => {
    const vocab: PersonaVocabularyMember[] = [
      { key: 'admin', displayName: 'Admin' },
      { key: 'legacy_role', displayName: 'Legacy', aliases: ['old_role'], status: 'retired' },
    ];
    for (const declared of ['legacy_role', 'old_role']) {
      const r = resolvePersona({ declared }, vocab);
      expect(r.persona).toBe('unknown');
      expect(r.unrecognizedDeclared).toBe(declared);
    }
  });

  it('a reserved key smuggled in as an alias never routes onto a member', () => {
    const vocab = [{ key: 'admin', displayName: 'Admin', aliases: ['unknown', '__all__'] }];
    expect(resolvePersona({ declared: 'unknown' }, vocab).persona).toBe('unknown');
    expect(resolvePersona({ declared: '__all__' }, vocab).persona).toBe('unknown');
  });
});

describe('resolvePersona — inferred path', () => {
  it('canonicalizes legacy cluster labels and passes confidence through', () => {
    expect(resolvePersona({ clusterLabel: 'deal-seekers', inferredConfidence: 0.45 })).toEqual({
      persona: 'deal_seeker',
      source: 'inferred',
      confidence: 0.45,
    });
  });

  it('does not serve an inferred persona the active vocabulary no longer contains', () => {
    const r = resolvePersona({ clusterLabel: 'buyer', inferredConfidence: 0.8 }, SAAS);
    expect(r).toEqual({ persona: 'unknown', source: 'none', confidence: 0.8 });
  });

  it('reroutes an inferred label through a rename alias', () => {
    const vocab = [{ key: 'purchaser', displayName: 'Purchaser', aliases: ['buyer'] }];
    expect(resolvePersona({ clusterLabel: 'buyers', inferredConfidence: 0.5 }, vocab).persona).toBe(
      'purchaser',
    );
  });

  it('nothing declared, nothing clustered → unknown at confidence 0', () => {
    expect(resolvePersona({})).toEqual({ persona: 'unknown', source: 'none', confidence: 0 });
    expect(resolvePersona({ clusterLabel: null, inferredConfidence: null })).toEqual({
      persona: 'unknown',
      source: 'none',
      confidence: 0,
    });
  });

  it('matches the pre-vocabulary decide behaviour for the default set', () => {
    // decide.ts today: canonicalPersona(cluster_label) + reliability_score.
    for (const label of ['buyer', 'researchers', null, 'garbage']) {
      const r = resolvePersona({ clusterLabel: label, inferredConfidence: 0.31 });
      expect(r.confidence).toBe(0.31);
      expect(r.persona).toBe(
        label === 'buyer' ? 'buyer' : label === 'researchers' ? 'researcher' : 'unknown',
      );
    }
  });
});

describe('decisionPersona', () => {
  it('trusts vocabulary keys verbatim — no squash through the global union', () => {
    expect(resolvePersonaModule.decisionPersona('admin')).toBe('admin');
    expect(resolvePersonaModule.decisionPersona('buyer')).toBe('buyer');
  });

  it('still remaps pre-069 legacy plural labels', () => {
    expect(resolvePersonaModule.decisionPersona('deal-seekers')).toBe('deal_seeker');
    expect(resolvePersonaModule.decisionPersona('buyers')).toBe('buyer');
  });

  it('null, empty, and whitespace are unknown', () => {
    for (const v of [null, undefined, '', '   ']) {
      expect(resolvePersonaModule.decisionPersona(v)).toBe('unknown');
    }
  });
});
