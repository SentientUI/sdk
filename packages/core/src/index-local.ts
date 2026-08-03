/**
 * @sentientui/core/local — the keyless local decision engine.
 *
 * Loaded ONLY under the `development` export condition (see the "./local"
 * exports map in package.json). Production bundles resolve this specifier to
 * `index-local-stub.ts`, so none of this code ships to production.
 *
 * Deterministic by construction: the same (sessionId, persona, declaration)
 * always yields the same decision — across calls, instances, tabs, and the
 * server/client boundary. No I/O, no randomness, no mutable state.
 */
import {
  PERSONAS,
  UNKNOWN_PERSONA,
  applyClusterHeuristic,
  fnv1a,
  pickDeterministicArm,
  type PersonaKey,
} from '@sentientui/policy';
import type { DecideOutcome, SlotDeclInput, SlotResult } from './index.js';

/**
 * Sentinel embedded so build-level tests can assert the production bundle
 * physically excludes the local engine (scripts/verify-local-exclusion.ts).
 * Do not rename without updating that script.
 */
export const LOCAL_ENGINE_SENTINEL = 'SENTIENT_LOCAL_ENGINE';

/** True on the real engine module, false on the production stub. */
export const LOCAL_ENGINE_AVAILABLE = true;

/** Simulated decisions carry a fixed mid confidence (band 'medium'). */
export const LOCAL_CONFIDENCE = 0.5;

/**
 * Maps a section id to a semantic section type by substring so
 * `applyClusterHeuristic` gets a useful sectionTypes map without a DOM graph.
 * First matching rule wins, in exactly this order.
 */
const SECTION_TYPE_RULES: Array<[substr: string, type: string]> = [
  ['pricing', 'pricing'],
  ['hero', 'hero'],
  ['faq', 'faq'],
  ['cta', 'cta'],
  ['trust', 'trust'],
  ['social', 'social_proof'],
  ['testimonial', 'social_proof'],
  ['feature', 'features'],
  ['comparison', 'comparison'],
  ['compare', 'comparison'],
  ['nav', 'navigation'],
];

export function inferSectionTypes(sections: string[]): Map<string, string> {
  const types = new Map<string, string>();
  for (const id of sections) {
    const lower = id.toLowerCase();
    const rule = SECTION_TYPE_RULES.find(([substr]) => lower.includes(substr));
    types.set(id, rule ? rule[1] : 'generic');
  }
  return types;
}

function resolvePersona(sessionId: string, forcedPersona?: string): PersonaKey {
  if (forcedPersona) {
    if ((PERSONAS as readonly string[]).includes(forcedPersona)) return forcedPersona as PersonaKey;
    if (forcedPersona === UNKNOWN_PERSONA) return UNKNOWN_PERSONA;
  }
  return PERSONAS[fnv1a(sessionId) % PERSONAS.length];
}

function decideSlot(sessionId: string, persona: PersonaKey, slot: SlotDeclInput): SlotResult | null {
  // Persona-salted session key — implements the spec's
  // stableHash(sessionId, slotId, sortedArms, forcedPersona) with the pinned
  // pickDeterministicArm signature, so forcing a persona visibly changes
  // tokens and arrangements.
  const saltedSession = `${sessionId}:${persona}`;
  if (slot.arms && slot.arms.length >= 2) {
    return pickDeterministicArm(saltedSession, slot.id, slot.arms);
  }
  if (slot.dims) {
    const result: Record<string, string> = {};
    for (const [dim, values] of Object.entries(slot.dims)) {
      if (!values || values.length < 2) return null;
      result[dim] = pickDeterministicArm(saltedSession, `${slot.id}.${dim}`, [...values]);
    }
    return result;
  }
  return null;
}

export function createLocalEngine(opts: { sessionId: string; forcedPersona?: string }): {
  decide(input: {
    sections?: string[];
    components?: Array<{ id: string; variantIds?: string[] }>;
    slots?: SlotDeclInput[];
  }): DecideOutcome;
} {
  const persona = resolvePersona(opts.sessionId, opts.forcedPersona);
  return {
    decide(input) {
      const layoutOrder =
        input.sections && input.sections.length > 0
          ? applyClusterHeuristic(input.sections, inferSectionTypes(input.sections), persona)
          : null;

      const assignments: Record<string, string> = {};
      for (const c of input.components ?? []) {
        if (c.variantIds && c.variantIds.length > 0) {
          assignments[c.id] = pickDeterministicArm(opts.sessionId, c.id, c.variantIds);
        }
      }

      const slots: Record<string, SlotResult> = {};
      for (const s of input.slots ?? []) {
        const result = decideSlot(opts.sessionId, persona, s);
        if (result !== null) slots[s.id] = result;
      }

      return { layoutOrder, assignments, slots, persona, confidence: LOCAL_CONFIDENCE };
    },
  };
}
