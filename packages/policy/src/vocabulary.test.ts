import { describe, expect, it } from 'vitest';
import * as resolvePersonaModule from './vocabulary';
import {
  DEFAULT_PERSONA_VOCABULARY,
  PERSONA_KEY_RE,
  normalizeDeclaredPersona,
  RESERVED_PERSONA_KEYS,
  resolvePersona,
  type PersonaVocabularyMember,
} from './vocabulary';

describe('PERSONA_KEY_RE', () => {
  it('accepts slug keys up to 32 chars', () => {
    for (const k of ['admin', 'trial_user', 'a', 'gift-hunter', 'x'.repeat(32)]) {
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
  it('reserves only the structural keys (in sync with migration 153)', () => {
    expect(RESERVED_PERSONA_KEYS).toEqual(['unknown', '__all__']);
  });
});

describe('DEFAULT_PERSONA_VOCABULARY', () => {
  it('is EMPTY — a project that declared nothing has no personas', () => {
    // Measured across all of production history before this changed: `unknown`
    // served 10,882 decisions and the four seeded personas served 18 between
    // them. They were decoration on an axis that was 99.8% empty, and each one
    // asserted something about visitors nobody had met.
    expect(DEFAULT_PERSONA_VOCABULARY).toEqual([]);
  });

  it('resolves everything to unknown without a vocabulary', () => {
    // The honest answer, and the one the pooled bandit has always acted on.
    expect(resolvePersona({ declared: 'admin' }).persona).toBe('unknown');
    expect(resolvePersona({ clusterLabel: 'evaluator' }).persona).toBe('unknown');
    expect(resolvePersona({ declared: 'admin' }).source).toBe('none');
  });
});

const SAAS: readonly PersonaVocabularyMember[] = [
  { key: 'admin', displayName: 'Admin' },
  { key: 'evaluator', displayName: 'Evaluator' },
];

describe('resolvePersona — declared path', () => {
  it('serves a declared member at confidence 1 regardless of inferred state', () => {
    expect(
      resolvePersona({ declared: 'admin', clusterLabel: 'evaluator', inferredConfidence: 0.9 }, SAAS),
    ).toEqual({ persona: 'admin', source: 'declared', confidence: 1 });
  });

  it('normalizes case and whitespace before matching', () => {
    expect(resolvePersona({ declared: '  Admin ' }, SAAS).persona).toBe('admin');
  });

  it('resolves an alias to its member key', () => {
    const vocab = [{ key: 'purchaser', displayName: 'Purchaser', aliases: ['customer'] }];
    expect(resolvePersona({ declared: 'customer' }, vocab)).toEqual({
      persona: 'purchaser',
      source: 'declared',
      confidence: 1,
    });
  });

  it('does not remap plurals — a plural is its own, unrecognized key', () => {
    // A plural-label alias map keyed on the seeded persona names used to
    // resolve a plural onto its singular. It went with those names; a
    // project that wants a second spelling declares it as an alias.
    const vocab = [{ key: 'admin', displayName: 'Admin' }];
    const r = resolvePersona({ declared: 'admins' }, vocab);
    expect(r.persona).toBe('unknown');
    expect(r.unrecognizedDeclared).toBe('admins');
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
      { declared: 'staff', clusterLabel: 'evaluator', inferredConfidence: 0.6 },
      SAAS,
    );
    const undeclared = resolvePersona({ clusterLabel: 'evaluator', inferredConfidence: 0.6 }, SAAS);
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
  it('normalizes cluster labels and passes confidence through', () => {
    const TRIALS = [{ key: 'trial_user', displayName: 'Trial user' }];
    expect(resolvePersona({ clusterLabel: ' Trial_User ', inferredConfidence: 0.45 }, TRIALS)).toEqual({
      persona: 'trial_user',
      source: 'inferred',
      confidence: 0.45,
    });
  });

  it('drops an inferred label when the project declared no vocabulary', () => {
    // The default case now. Clustering cannot mint a persona on its own — only
    // `declared` or a `discovered` set that cleared the promotion gate can.
    expect(resolvePersona({ clusterLabel: 'trial_user', inferredConfidence: 0.9 }).persona)
      .toBe('unknown');
  });

  it('does not serve an inferred persona the active vocabulary no longer contains', () => {
    const r = resolvePersona({ clusterLabel: 'trial_user', inferredConfidence: 0.8 }, SAAS);
    expect(r).toEqual({ persona: 'unknown', source: 'none', confidence: 0.8 });
  });

  it('reroutes an inferred label through a rename alias', () => {
    const vocab = [{ key: 'purchaser', displayName: 'Purchaser', aliases: ['customer'] }];
    expect(resolvePersona({ clusterLabel: 'customer', inferredConfidence: 0.5 }, vocab).persona).toBe(
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

  it('resolves inferred labels against whatever the project actually declared', () => {
    // Was "matches the pre-vocabulary decide behaviour for the default set".
    // There is no default set now, so the vocabulary is passed explicitly and
    // the assertion is the same: canonicalize, then require membership.
    const VOCAB = [
      { key: 'admin', displayName: 'Admin' },
      { key: 'evaluator', displayName: 'Evaluator' },
    ];
    for (const label of ['admin', 'Evaluator', null, 'garbage']) {
      const r = resolvePersona({ clusterLabel: label, inferredConfidence: 0.31 }, VOCAB);
      expect(r.confidence).toBe(0.31);
      expect(r.persona).toBe(
        label === 'admin' ? 'admin' : label === 'Evaluator' ? 'evaluator' : 'unknown',
      );
    }
  });
});

describe('decisionPersona', () => {
  it('trusts vocabulary keys verbatim — no squash through the global union', () => {
    expect(resolvePersonaModule.decisionPersona('admin')).toBe('admin');
    expect(resolvePersonaModule.decisionPersona('Evaluator ')).toBe('evaluator');
  });

  it('remaps no label by name — plurals stay as stored', () => {
    expect(resolvePersonaModule.decisionPersona('admins')).toBe('admins');
  });

  it('null, empty, and whitespace are unknown', () => {
    for (const v of [null, undefined, '', '   ']) {
      expect(resolvePersonaModule.decisionPersona(v)).toBe('unknown');
    }
  });
});

describe('normalizeDeclaredPersona', () => {
  it('accepts and normalizes a real persona key', () => {
    expect(normalizeDeclaredPersona('  Admin ')).toBe('admin');
    expect(normalizeDeclaredPersona('power_user')).toBe('power_user');
    expect(normalizeDeclaredPersona('tier-2')).toBe('tier-2');
  });

  it('refuses anything that could not BE a key, so PII never reaches storage', () => {
    // sessions.declared_persona and the unrecognized-value counter (rendered
    // verbatim in Settings) took whatever the browser sent, so a customer
    // wiring persona={user.email} filed real addresses in both.
    expect(normalizeDeclaredPersona('someone@example.com')).toBeNull();
    expect(normalizeDeclaredPersona('Jane Doe')).toBeNull();
    expect(normalizeDeclaredPersona('x'.repeat(33))).toBeNull();
    expect(normalizeDeclaredPersona('')).toBeNull();
    expect(normalizeDeclaredPersona('   ')).toBeNull();
    expect(normalizeDeclaredPersona(null)).toBeNull();
    expect(normalizeDeclaredPersona(undefined)).toBeNull();
  });

  it('still admits a plain typo, so the "add it?" nudge keeps working', () => {
    // The whole point of the miss counter is to surface a key the app sends
    // that the vocabulary lacks — validation must not swallow those.
    expect(normalizeDeclaredPersona('staff')).toBe('staff');
    expect(normalizeDeclaredPersona('adminn')).toBe('adminn');
  });
});
