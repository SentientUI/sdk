import { UNKNOWN_PERSONA } from './personas';

/**
 * Per-project persona vocabularies (spec: 2026-08-27-declared-personas-design.md).
 *
 * The persona axis is a per-project member list (persona_sets / persona_set_members,
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
 * Normalizes a persona value declared by the SDK, or returns null when it is
 * not shaped like a persona key at all.
 *
 * The SDK docs all say "never a user id or email", and migration 113's CHECK
 * keeps such a value out of `persona_set_members.key` — but the two ingest
 * sinks added later (`sessions.declared_persona` and the unrecognized-value
 * counter, which the Settings page renders verbatim) took whatever the browser
 * sent. A customer wiring `persona={user.email}` therefore put real addresses
 * in both, with no subject-erasure path out of the counter.
 *
 * Rejecting here loses nothing the nudge needs: a genuine typo like 'staff'
 * still matches, so it is still counted and still offered as "add it?". Only
 * values that could never BE a key — anything with '@', a space, uppercase, or
 * over 32 characters — are refused.
 */
export function normalizeDeclaredPersona(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  return PERSONA_KEY_RE.test(value) ? value : null;
}

/**
 * Keys no vocabulary member may claim: 'unknown' and '__all__' are structural
 * in weightCellsFor / CONTRACTS §4. MUST stay in sync with the CHECK constraint
 * on persona_set_members.key (migration 113, relaxed by 153).
 *
 * This also reserved four plural labels until 2026-09-13, because the
 * name-specific alias map that remapped them at resolve time would have
 * silently rewritten a member claiming one. That map went with the seeded
 * personas, so those strings are ordinary keys now.
 */
export const RESERVED_PERSONA_KEYS: readonly string[] = ['unknown', '__all__'];

/**
 * Canonicalizes any persona/cluster label to a persona KEY: trimmed,
 * lowercased, and shaped like one (`PERSONA_KEY_RE`). Null, empty, and
 * anything that could never be a key become 'unknown' — "we don't know" is
 * always a safe answer.
 *
 * Generic on purpose. This used to be a lookup in a table of four seeded
 * persona names, so every OTHER label — including every key a customer
 * declared — folded to 'unknown': a registry pin scoped to `admin` was stored
 * under 'unknown' and then applied to every unidentified visitor. It says
 * nothing about membership; callers that serve must still check the project's
 * vocabulary (resolvePersona does).
 */
export function canonicalPersona(label: string | null | undefined): string {
  return normalizeDeclaredPersona(label) ?? UNKNOWN_PERSONA;
}

export type PersonaVocabularyMember = {
  key: string;
  displayName: string;
  /** Prior keys (renames) that resolve to this member. */
  aliases?: readonly string[];
  /** Retired members stop resolving but their weight rows keep pooling. */
  status?: 'active' | 'retired';
};

/**
 * The vocabulary a project has when it has declared nothing: EMPTY.
 *
 * This shipped as a hardcoded four seeded personas, which the product then
 * presented as if it knew the customer's audience.
 * Earned rows (2026-09-12) demoted them to a `starter` state; this removes them.
 *
 * The measurement that settled it, across all of production history:
 * `unknown` served 10,882 decisions, the four seeded personas served **18
 * between them**. They were not a taxonomy, they were decoration on an axis
 * that was 99.8% empty — and every one of them was an assertion about visitors
 * nobody had met.
 *
 * A persona now has exactly two honest origins:
 *
 *   - **declared** — the customer's own code tells us (a role, a plan tier).
 *     Ground truth; no evidence gate, because eligibility is their decision.
 *   - **discovered** — `persona-discovery.ts` finds it in real behaviour and it
 *     clears the interaction gate (the RANKING of arms must differ inside vs
 *     outside the segment, not merely the conversion rate).
 *
 * Everything else resolves to `unknown`, which is where day-0 value accrues and
 * where the pooled bandit has always done the actual work.
 *
 * THIS IS ONLY SAFE BECAUSE SERVING NO LONGER NEEDS A PERSONA. The factored
 * model (migration 149) conditions on device, source and visit count as
 * first-class factors — measured, not guessed — so a project with no personas
 * still adapts per visitor. Before that landed, emptying this would have meant
 * no personalization at all.
 */
export const DEFAULT_PERSONA_VOCABULARY: readonly PersonaVocabularyMember[] = [];

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
 * 1. Declared value matching an active member (directly or via alias) → that key,
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
    const match = lookup.get(declaredRaw);
    if (match !== undefined) {
      return { persona: match, source: 'declared', confidence: 1 };
    }
    unrecognizedDeclared = declaredRaw.slice(0, UNRECOGNIZED_MAX_LEN);
  }

  // Membership is what gates serving; canonicalPersona only shapes the key.
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
 * was written, and re-squashing it through a closed global union at close-out
 * silently rerouted every declared-persona trial onto the 'unknown' marginals
 * (the double-squash bug, spec §4.3).
 *
 * It also remapped four pre-069 plural labels until 2026-09-13; migration 069
 * had already rewritten those rows, and the remap was keyed on the retired
 * seeded names, so it went with them.
 */
export function decisionPersona(label: string | null | undefined): string {
  if (label == null) return UNKNOWN_PERSONA;
  const normalized = label.trim().toLowerCase();
  return normalized === '' ? UNKNOWN_PERSONA : normalized;
}
