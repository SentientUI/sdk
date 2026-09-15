import { hashLayout } from './hash';
// Type-only import: the taxonomy subpath is server-only (its topic table costs
// ~405 bytes gzip the browser never reads), but a type erases at build, so the
// barrel stays clean of its runtime code.
import type { SectionRole } from './taxonomy';

/**
 * A catalogue of plausible page orderings — NOT a persona taxonomy.
 *
 * These four orderings were keyed by the four seeded persona names until
 * 2026-09-13 (the table was exported as `CLUSTER_PRIORITY`, now removed).
 * Those personas were removed, but the deeper problem was that keying orderings by persona NAME was
 * wrong even while they existed, in two ways that were invisible until a
 * customer declared a persona of their own:
 *
 *  1. THE ARM SPACE DEPENDED ON WHAT THE CUSTOMER NAMED THEIR PERSONA. A
 *     project that declared `admin` got five candidate orders including the
 *     page exactly as authored; a project that declared one of the seeded names got four, and
 *     the authored order was NOT among them — so its own page order could never
 *     be served to that persona, and there was no control arm to lose to.
 *     Renaming a persona silently changed which layouts were reachable.
 *
 *  2. THE FEASIBILITY GATE SERVED THE COLLIDING ARCHETYPE DETERMINISTICALLY.
 *     `routes/decide.ts` serves a heuristic order (never explored, never
 *     learned) when layout feasibility is `infeasible` — the state every new
 *     project is in. A customer who declared the seeded conversion persona had pricing hoisted above
 *     everything on every visit, permanently, because of a table written in
 *     May; a customer who declared `admin` correctly kept their own page.
 *
 * So the orderings are now named for what they DO. The names are internal and
 * carry no claim about any visitor: they are four opinions about what a page
 * should lead with, and the bandit decides between them and the authored order
 * using evidence. The arrays are unchanged, so every `layout_weights` row in
 * production still joins — `hashLayout` hashes the resulting ORDER, never the
 * key that produced it.
 */
export const LAYOUT_ARCHETYPES: Record<string, readonly string[]> = {
  /** Lead with the ask: price and CTA first. */
  conversion_led: ['pricing', 'cta', 'hero', 'comparison', 'social_proof', 'trust', 'features', 'faq', 'navigation', 'generic'],
  /** Lead with substance: detail and comparison before the ask. */
  evidence_led: ['features', 'comparison', 'faq', 'hero', 'trust', 'social_proof', 'pricing', 'cta', 'navigation', 'generic'],
  /** Lead with value: price framed by proof. */
  price_led: ['pricing', 'comparison', 'social_proof', 'trust', 'cta', 'hero', 'features', 'faq', 'navigation', 'generic'],
  /** Lead with orientation: the conventional marketing order. */
  discovery_led: ['hero', 'features', 'social_proof', 'pricing', 'cta', 'trust', 'faq', 'comparison', 'navigation', 'generic'],
};

/** The archetype names, in a pinned order — iteration order decides candidate
 *  insertion order, so it must not depend on object-key enumeration luck. */
export const LAYOUT_ARCHETYPE_NAMES = [
  'conversion_led', 'evidence_led', 'price_led', 'discovery_led',
] as const;

export type LayoutArchetype = (typeof LAYOUT_ARCHETYPE_NAMES)[number];

/**
 * Reorders section IDs by one archetype's semantic priority.
 * Sections with no graph entry are treated as 'generic'.
 *
 * With `sectionRoles` (spec 2026-09-04 §1, phase 2d) the ordering projection is
 * `(role, parent)`: structural sections are PINNED at their original index and
 * only converters/persuaders re-rank around them. The pin is not cosmetic —
 * 'navigation' ranks near last in every archetype, so an unpinned navbar or
 * footer would sort to the bottom of the page, exactly the visible damage a
 * reorder must never do. Callers without role data (the client-local fallback)
 * omit the map and get the pre-2d behaviour unchanged.
 */
export function orderByArchetype(
  sections: string[],
  sectionTypes: Map<string, string>,
  archetype: LayoutArchetype,
  sectionRoles?: Map<string, SectionRole>,
): string[] {
  const priority = LAYOUT_ARCHETYPES[archetype];
  if (!priority) return sections;
  // A type that is PRESENT but off-vocabulary (e.g. 'newsletter') yields
  // indexOf === -1, which would sort it BEFORE index 0 ('pricing') and hijack the
  // top of the layout. Map any unrecognized type to 'generic''s rank (last) —
  // the same bucket as a missing entry.
  const genericRank = priority.indexOf('generic');
  const rank = (type: string): number => {
    const i = priority.indexOf(type);
    return i === -1 ? genericRank : i;
  };
  const movable = sectionRoles
    ? sections.filter((s) => sectionRoles.get(s) !== 'structural')
    : [...sections];
  movable.sort((a, b) => {
    const typeA = sectionTypes.get(a) ?? 'generic';
    const typeB = sectionTypes.get(b) ?? 'generic';
    return rank(typeA) - rank(typeB);
  });
  if (!sectionRoles) return movable;
  let m = 0;
  return sections.map((s) => (sectionRoles.get(s) === 'structural' ? s : movable[m++]!));
}

/** FNV-1a. Only used to spread arbitrary preview keys over the archetypes. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * PREVIEW ONLY — the keyless local engine (`@sentientui/core` index-local).
 *
 * Maps an arbitrary persona string to one archetype so that
 * `?sentient_persona=<anything>` visibly rearranges a page with no API key and
 * no server. It used to look the key up in the four-persona table, so only
 * the four seeded names did anything and every other key silently no-oped;
 * now any key previews an arrangement, which is what the docs promise.
 *
 * DO NOT USE THIS ON THE SERVER. The mapping is a hash, not a belief: it
 * carries no claim that this persona wants this ordering. Server serving picks
 * between the archetypes and the authored order with `chooseLayout` /
 * `chooseLayoutFactored`, on evidence.
 *
 * 'unknown' and the empty string return the sections untouched — the natural
 * order is what an unidentified visitor gets, here as everywhere.
 */
export function previewOrderForPersona(
  sections: string[],
  sectionTypes: Map<string, string>,
  persona: string,
  sectionRoles?: Map<string, SectionRole>,
): string[] {
  if (!persona || persona === 'unknown') return sections;
  const name = LAYOUT_ARCHETYPE_NAMES[hashString(persona) % LAYOUT_ARCHETYPE_NAMES.length]!;
  return orderByArchetype(sections, sectionTypes, name, sectionRoles);
}

/**
 * @deprecated Renamed. Use `orderByArchetype` on the server (by archetype) or
 * `previewOrderForPersona` in the keyless local engine (by arbitrary key).
 * Kept as an alias of the preview mapping so the published signature survives.
 */
export const applyClusterHeuristic = previewOrderForPersona;

/**
 * The candidate layout orderings for a page — the arms the layout bandit
 * explores. Returned as hash → order so it joins directly against
 * `layout_weights` rows keyed by the same `hashLayout`.
 *
 * THE AUTHORED ORDER IS ALWAYS AN ARM. It is the control: the customer built
 * this page in this order, and a bandit whose arm space excludes the baseline
 * can never conclude "leave it alone" — it is structurally obliged to reorder
 * something, and there is nothing for a holdout comparison to mean. Before
 * 2026-09-13 the authored order was included only by accident, when the
 * requesting persona's name happened to miss the archetype table; a persona
 * whose name matched the table had it excluded entirely.
 *
 * It no longer takes a persona. The set of orderings a page COULD be shown in
 * is a property of the page, not of who is looking at it — what the persona
 * changes is which arm wins, and that is the posterior's job.
 */
export function candidateLayouts(
  sections: string[],
  sectionTypes: Map<string, string>,
  sectionRoles?: Map<string, SectionRole>,
): Map<string, string[]> {
  const byHash = new Map<string, string[]>();
  // Authored order first, so it is the map's insertion-order head and wins any
  // downstream tie broken by iteration order.
  byHash.set(hashLayout(sections), [...sections]);
  for (const name of LAYOUT_ARCHETYPE_NAMES) {
    const order = orderByArchetype(sections, sectionTypes, name, sectionRoles);
    const hash = hashLayout(order);
    if (!byHash.has(hash)) byHash.set(hash, order);
  }
  return byHash;
}
