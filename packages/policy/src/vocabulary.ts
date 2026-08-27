import { PERSONAS, PERSONA_DISPLAY, UNKNOWN_PERSONA, LEGACY_PERSONA_MAP, canonicalPersona } from './personas';

/**
 * Per-project persona vocabularies (spec: 2026-08-27-declared-personas-design.md).
 *
 * The persona axis stops being the closed global union in `personas.ts` and
 * becomes a per-project member list (persona_sets / persona_set_members,
 * migration 113). This module owns resolution: which persona a decision is
 * keyed on, given what the customer's app declared and what clustering
 * inferred. The weight tables and pooling are already string-generic —
 * resolution is the only place vocabulary rules live.
 */

/**
 * Key shape for vocabulary members. Personas are partition labels that land in
 * slot_weights and in customers' CSS selectors — no '@', no spaces, no
 * uppercase, so emails/usernames structurally cannot become partition keys.
 * MUST stay in sync with the CHECK constraint in migration 113.
 */
export const PERSONA_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Keys no vocabulary member may claim. 'unknown' and '__all__' are structural
 * in weightCellsFor / CONTRACTS §4; the plural forms are pre-069 legacy labels
 * that canonicalPersona still remaps, so a member claiming one would be
 * silently rewritten at resolve time. MUST stay in sync with migration 113.
 */
export const RESERVED_PERSONA_KEYS: readonly string[] = [
  'unknown',
  '__all__',
  'buyers',
  'researchers',
  'deal-seekers',
  'browsers',
];

export type PersonaVocabularyMember = {
  key: string;
  displayName: string;
  /** Prior keys (renames) that resolve to this member. */
  aliases?: readonly string[];
  /** Retired members stop resolving but their weight rows keep pooling. */
  status?: 'active' | 'retired';
};

/**
 * The pinned four as a vocabulary — what every project's version-1 default set
 * contains, and the fallback when a project has no active set (a missed
 * app-code insert degrades to today's behaviour, never an error).
 */
export const DEFAULT_PERSONA_VOCABULARY: readonly PersonaVocabularyMember[] = PERSONAS.map(
  (key) => ({ key, displayName: PERSONA_DISPLAY[key] }),
);

export type PersonaResolution = {
  /** Vocabulary key, or 'unknown'. This is what decisions/weights key on. */
  persona: string;
  /** Which path produced the persona; 'none' means nothing resolved. */
  source: 'declared' | 'inferred' | 'none';
  /** Declared is ground truth from the customer's own app → 1. Otherwise the
   *  portrait reliability the caller passed through (0 when absent). */
  confidence: number;
  /** Set when a declared value did not resolve — feeds the dashboard's
   *  "your app sent 'staff' 1.2k times, add it?" nudge. Normalized and
   *  truncated; never served. */
  unrecognizedDeclared?: string;
};

/** Longest unrecognized value we report back; beyond this it is junk, not a typo. */
const UNRECOGNIZED_MAX_LEN = 64;

type Lookup = Map<string, string>;

/**
 * key/alias → member key, active members only. Retired members and their
 * aliases are excluded so a retired persona cannot re-enter serving through
 * the alias door.
 */
function buildLookup(members: readonly PersonaVocabularyMember[]): Lookup {
  const lookup: Lookup = new Map();
  for (const m of members) {
    if (m.status === 'retired') continue;
    lookup.set(m.key, m.key);
    // Reserved keys cannot be members (migration 113 CHECK) but aliases have no
    // DB constraint — skip them here so a bad alias row can never route
    // 'unknown' or '__all__' traffic onto a real member's posteriors.
    for (const a of m.aliases ?? []) {
      if (!RESERVED_PERSONA_KEYS.includes(a)) lookup.set(a, m.key);
    }
  }
  return lookup;
}

/**
 * Resolves the persona a decision is keyed on.
 *
 * Precedence, in order:
 * 1. Declared value matching an active member (directly, via alias, or via a
 *    legacy plural label whose canonical form is a member) → that key,
 *    confidence 1. Declared skips reliability gating: it is ground truth from
 *    the customer's app, the same trust level as everything else the pk_ key
 *    sends.
 * 2. Declared present but unrecognized → NOT served (a config gap is not a
 *    signal); reported via `unrecognizedDeclared` and resolution falls through
 *    to the inferred path, byte-identical to an undeclared session.
 * 3. Inferred cluster label, canonicalized, but only if the active vocabulary
 *    still contains it — a retired member must not keep being served just
 *    because the nightly refit still emits its label.
 */
export function resolvePersona(
  input: {
    declared?: string | null;
    clusterLabel?: string | null;
    inferredConfidence?: number | null;
  },
  members: readonly PersonaVocabularyMember[] = DEFAULT_PERSONA_VOCABULARY,
): PersonaResolution {
  const lookup = buildLookup(members);
  const inferredConfidence = input.inferredConfidence ?? 0;

  let unrecognizedDeclared: string | undefined;
  const declaredRaw = input.declared?.trim().toLowerCase() ?? '';
  if (declaredRaw !== '') {
    // Direct/alias hit first; then the legacy plural map, gated on the
    // canonical form actually being a member ('buyers' works iff 'buyer' does).
    const direct = lookup.get(declaredRaw);
    const viaLegacy = direct === undefined ? lookup.get(canonicalPersona(declaredRaw)) : undefined;
    const match = direct ?? viaLegacy;
    if (match !== undefined) {
      return { persona: match, source: 'declared', confidence: 1 };
    }
    unrecognizedDeclared = declaredRaw.slice(0, UNRECOGNIZED_MAX_LEN);
  }

  const inferred = canonicalPersona(input.clusterLabel);
  if (inferred !== UNKNOWN_PERSONA && lookup.has(inferred)) {
    return { persona: lookup.get(inferred)!, source: 'inferred', confidence: inferredConfidence, ...(unrecognizedDeclared !== undefined && { unrecognizedDeclared }) };
  }

  return { persona: UNKNOWN_PERSONA, source: 'none', confidence: inferredConfidence, ...(unrecognizedDeclared !== undefined && { unrecognizedDeclared }) };
}

/**
 * Normalizes a DECISION-TIME persona (slot_decisions / layout_decisions rows)
 * for training. Unlike `canonicalPersona`, this trusts the stored value
 * verbatim: it was validated against the project vocabulary when the decision
 * was written, and re-squashing it through the closed global union at close-out
 * silently rerouted every declared-persona trial onto the 'unknown' marginals
 * (the double-squash bug, spec §4.3). Only the legacy plural labels are still
 * remapped — pre-069 rows carry them.
 */
export function decisionPersona(label: string | null | undefined): string {
  if (label == null) return UNKNOWN_PERSONA;
  const normalized = label.trim().toLowerCase();
  if (normalized === '') return UNKNOWN_PERSONA;
  return LEGACY_PERSONA_MAP[normalized] ?? normalized;
}
