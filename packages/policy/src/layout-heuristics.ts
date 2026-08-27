import { PERSONAS, type Persona } from './personas';
import { hashLayout } from './hash';

export const CLUSTER_PRIORITY: Record<Persona, string[]> = {
  buyer: ['pricing', 'cta', 'hero', 'comparison', 'social_proof', 'trust', 'features', 'faq', 'navigation', 'generic'],
  researcher: ['features', 'comparison', 'faq', 'hero', 'trust', 'social_proof', 'pricing', 'cta', 'navigation', 'generic'],
  deal_seeker: ['pricing', 'comparison', 'social_proof', 'trust', 'cta', 'hero', 'features', 'faq', 'navigation', 'generic'],
  browser: ['hero', 'features', 'social_proof', 'pricing', 'cta', 'trust', 'faq', 'comparison', 'navigation', 'generic'],
};

/**
 * Reorders section IDs based on the persona's semantic priority.
 * Sections with no graph entry are treated as 'generic'.
 * Returns the input unchanged for 'unknown' — and for any custom vocabulary
 * persona (declared/discovered): those have no semantic prior, so they serve
 * the natural order until the layout bandit has learned rows, the same
 * cold-start posture 'unknown' gets.
 */
export function applyClusterHeuristic(
  sections: string[],
  sectionTypes: Map<string, string>,
  persona: string,
): string[] {
  const priority = (CLUSTER_PRIORITY as Partial<Record<string, string[]>>)[persona];
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
  return [...sections].sort((a, b) => {
    const typeA = sectionTypes.get(a) ?? 'generic';
    const typeB = sectionTypes.get(b) ?? 'generic';
    return rank(typeA) - rank(typeB);
  });
}

/**
 * The candidate layout orderings for a page — the distinct section orders
 * produced by every persona's semantic priority (plus the requesting
 * persona's own, which for 'unknown' is the identity order). These are the
 * "arms" the layout bandit explores. Returned as hash → order so it joins
 * directly against layout_weights rows keyed by the same hashLayout.
 */
export function candidateLayouts(
  sections: string[],
  sectionTypes: Map<string, string>,
  persona: string,
): Map<string, string[]> {
  const byHash = new Map<string, string[]>();
  for (const cluster of [...PERSONAS, persona]) {
    const order = applyClusterHeuristic(sections, sectionTypes, cluster);
    byHash.set(hashLayout(order), order);
  }
  return byHash;
}
