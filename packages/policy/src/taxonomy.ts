/**
 * Two-layer section vocabulary (spec 2026-09-04).
 *
 * `parent` is the existing 10-value enum. It is the ONLY layer the layout
 * bandit orders on, so the arm space stays bounded however rich `topic` grows —
 * adding `carbon_fibre` buys understanding and zero extra bandit arms. That
 * bound is load-bearing: a low-traffic project cannot support more arms (see
 * the feasibility analysis in the spec), so widening the ordering vocabulary
 * would make the statistics worse, not better.
 *
 * `topic` is the real semantics. The shipped classifier was tuned on SaaS
 * marketing pages and returns `generic` for 8 of 9 sections on a car-body-repair
 * site (measured — see the spec), which is why `services`, `gallery`, `process`
 * and `insurance` exist here at all.
 *
 * `role` is orthogonal to both and describes what a section is FOR:
 *   - converter  — carries a reward trigger (declared goal, form, tel:, booking)
 *   - persuader  — no trigger; earns its place through dwell, feeds persona dims
 *   - structural — nav/footer/breadcrumb; evidence for neither, and reordering
 *                  it would visibly damage the page
 * Only converters and persuaders are reorderable; structural sections are pinned.
 *
 * NOTE: `role` here is the topic's DEFAULT. Phase 2b overrides it per section
 * from real evidence (a declared goal's locator resolving inside the section),
 * because a `services` band containing a "Book now" button really is a converter.
 */

export const SEMANTIC_PARENTS = [
  'pricing', 'hero', 'social_proof', 'cta', 'features',
  'faq', 'comparison', 'trust', 'navigation', 'generic',
] as const;

export type SemanticParent = (typeof SEMANTIC_PARENTS)[number];
export type SectionRole = 'converter' | 'persuader' | 'structural';

export const TOPICS: ReadonlyArray<{ topic: string; parent: SemanticParent; role: SectionRole }> = [
  // pricing
  { topic: 'pricing_plans', parent: 'pricing', role: 'converter' },
  { topic: 'financing', parent: 'pricing', role: 'persuader' },
  { topic: 'quote', parent: 'pricing', role: 'converter' },
  // hero
  { topic: 'hero', parent: 'hero', role: 'converter' },
  // social proof
  { topic: 'reviews', parent: 'social_proof', role: 'persuader' },
  { topic: 'testimonials', parent: 'social_proof', role: 'persuader' },
  { topic: 'case_study', parent: 'social_proof', role: 'persuader' },
  { topic: 'brands', parent: 'social_proof', role: 'persuader' },
  { topic: 'awards', parent: 'social_proof', role: 'persuader' },
  { topic: 'press', parent: 'social_proof', role: 'persuader' },
  { topic: 'stats', parent: 'social_proof', role: 'persuader' },
  { topic: 'gallery', parent: 'social_proof', role: 'persuader' },
  // cta
  { topic: 'cta', parent: 'cta', role: 'converter' },
  { topic: 'booking', parent: 'cta', role: 'converter' },
  { topic: 'contact_form', parent: 'cta', role: 'converter' },
  { topic: 'newsletter', parent: 'cta', role: 'converter' },
  { topic: 'hours', parent: 'cta', role: 'persuader' },
  { topic: 'location', parent: 'cta', role: 'persuader' },
  // features
  { topic: 'services', parent: 'features', role: 'persuader' },
  { topic: 'features', parent: 'features', role: 'persuader' },
  { topic: 'process', parent: 'features', role: 'persuader' },
  { topic: 'capabilities', parent: 'features', role: 'persuader' },
  { topic: 'specialties', parent: 'features', role: 'persuader' },
  { topic: 'menu', parent: 'features', role: 'persuader' },
  { topic: 'inventory', parent: 'features', role: 'converter' },
  { topic: 'integrations', parent: 'features', role: 'persuader' },
  // faq / comparison
  { topic: 'faq', parent: 'faq', role: 'persuader' },
  { topic: 'comparison', parent: 'comparison', role: 'persuader' },
  // trust
  { topic: 'insurance', parent: 'trust', role: 'persuader' },
  { topic: 'warranty', parent: 'trust', role: 'persuader' },
  { topic: 'certifications', parent: 'trust', role: 'persuader' },
  { topic: 'security', parent: 'trust', role: 'persuader' },
  { topic: 'guarantee', parent: 'trust', role: 'persuader' },
  { topic: 'about', parent: 'trust', role: 'persuader' },
  { topic: 'team', parent: 'trust', role: 'persuader' },
  // navigation (structural)
  { topic: 'navigation', parent: 'navigation', role: 'structural' },
  { topic: 'footer', parent: 'navigation', role: 'structural' },
  { topic: 'breadcrumb', parent: 'navigation', role: 'structural' },
  { topic: 'cookie_banner', parent: 'navigation', role: 'structural' },
  // generic
  { topic: 'generic', parent: 'generic', role: 'persuader' },
  { topic: 'blog', parent: 'generic', role: 'persuader' },
  { topic: 'resources', parent: 'generic', role: 'persuader' },
  { topic: 'careers', parent: 'generic', role: 'persuader' },
  { topic: 'legal', parent: 'generic', role: 'persuader' },
];

// /* @__PURE__ */ is load-bearing, not decoration. Without it a bundler cannot
// prove `new Map(...)` is side-effect-free, so it retains this initialiser and
// everything it references — which shipped all 44 TOPICS into the always-on
// snippet bundle (+405 bytes gzip on EVERY page view of every customer site)
// even though only the server ever reads them. `sideEffects: false` on the
// package is not enough on its own for a top-level constructor call.
const BY_TOPIC = /* @__PURE__ */ new Map(TOPICS.map((t) => [t.topic, t]));

/** Project a topic onto the parent the bandit orders on. Unknown → 'generic':
 *  an unrecognised topic must never hijack an ordering slot — the same reasoning
 *  as the off-vocabulary guard in layout-heuristics.ts, where a present-but-
 *  unrecognised type yielded indexOf === -1 and sorted ahead of everything. */
export function parentOfTopic(topic: string): SemanticParent {
  return BY_TOPIC.get(topic)?.parent ?? 'generic';
}

/** Default role for a topic. Unknown → 'persuader', never 'structural':
 *  structural sections are PINNED and never reordered, so defaulting an unknown
 *  topic to structural would silently freeze real content in place — failing
 *  closed in the direction that does the least harm. */
export function roleOfTopic(topic: string): SectionRole {
  return BY_TOPIC.get(topic)?.role ?? 'persuader';
}
