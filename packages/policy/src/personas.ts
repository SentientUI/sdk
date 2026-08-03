export const PERSONAS = ['buyer', 'researcher', 'deal_seeker', 'browser'] as const;
export type Persona = (typeof PERSONAS)[number];

export const UNKNOWN_PERSONA = 'unknown' as const;
export type PersonaKey = Persona | typeof UNKNOWN_PERSONA;

/** Human-facing names — dashboard/devtools copy must use these, never raw keys. */
export const PERSONA_DISPLAY: Record<PersonaKey, string> = {
  buyer: 'Buyer',
  researcher: 'Researcher',
  deal_seeker: 'Deal seeker',
  browser: 'Browser',
  unknown: 'Unknown',
};

/**
 * Every label ever written for a persona, mapped to its canonical form. The
 * plural/hyphen labels are the pre-069 cluster seed labels
 * ('buyers'/'deal-seekers'/…); identity mappings make canonical input a no-op.
 */
export const LEGACY_PERSONA_MAP: Record<string, Persona> = {
  buyers: 'buyer',
  researchers: 'researcher',
  'deal-seekers': 'deal_seeker',
  browsers: 'browser',
  buyer: 'buyer',
  researcher: 'researcher',
  deal_seeker: 'deal_seeker',
  browser: 'browser',
};

/**
 * Canonicalizes any persona/cluster label to the pinned vocabulary.
 * Null, undefined, empty, and unrecognized labels all become 'unknown' —
 * "we don't know" is always a safe answer; a guessed persona is not.
 */
export function canonicalPersona(label: string | null | undefined): PersonaKey {
  if (label == null) return UNKNOWN_PERSONA;
  const normalized = label.trim().toLowerCase();
  return LEGACY_PERSONA_MAP[normalized] ?? UNKNOWN_PERSONA;
}
