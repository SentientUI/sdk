// Rich topic vocabulary for section classification (Phase 2b, spec 2026-09-04).
//
// SERVER-ONLY. This module is deliberately NOT imported by ./classify.ts, which
// the browser bundles: the tables below cost ~1.5 KB gzip, which is 7% of the
// always-on snippet, on every page view of every customer site — for a layer
// the browser never reads (classifySection returns only the parent).
//
// It shares structuralTopicOf/fallbackTopicOf with ./classify.ts, so client and
// server agree on structure and fallbacks; only vocabulary richness differs.
//
// The topic→parent mapping is DUPLICATED from packages/policy/src/taxonomy.ts,
// for the same bundle reason — core must not import the policy taxonomy.
// apps/api/src/domain/classifier-taxonomy-sync.test.ts fails if the two drift.

import {
  structuralTopicOf,
  fallbackTopicOf,
  type SectionFeatures,
  type SemanticType,
  type TopicRule,
} from './classify.js';

/**
 * Version of the classification BEHAVIOUR (rules + taxonomy + stages), read by
 * the server's shadow-label rollout (section-classify.ts): a project whose
 * promoted version differs gets new labels written to SHADOW only, while its
 * old labels keep serving until an operator promotes (with one-click rollback,
 * the A4 pattern).
 *
 * BUMP THIS whenever a change here or in ./classify.ts alters what any section
 * would be labelled — rule edits, threshold changes, new stages, taxonomy
 * moves. Comment-only and refactor-only changes do not bump. The corpus gates
 * catch accuracy regressions; this constant is what keeps a deliberate
 * improvement from silently re-labelling every live project's serving rows on
 * their next audit.
 */
export const CLASSIFIER_VERSION = '2026-09-05';

export const CLASSIFIER_TOPICS: readonly TopicRule[] = [
  { topic: 'navigation', parent: 'navigation', role: 'structural' },
  { topic: 'footer', parent: 'navigation', role: 'structural' },
  { topic: 'breadcrumb', parent: 'navigation', role: 'structural' },
  { topic: 'cookie_banner', parent: 'navigation', role: 'structural' },
  { topic: 'hero', parent: 'hero', role: 'converter' },
  { topic: 'pricing_plans', parent: 'pricing', role: 'converter' },
  { topic: 'quote', parent: 'pricing', role: 'converter' },
  { topic: 'financing', parent: 'pricing', role: 'persuader' },
  { topic: 'faq', parent: 'faq', role: 'persuader' },
  { topic: 'comparison', parent: 'comparison', role: 'persuader' },
  { topic: 'reviews', parent: 'social_proof', role: 'persuader' },
  { topic: 'testimonials', parent: 'social_proof', role: 'persuader' },
  { topic: 'case_study', parent: 'social_proof', role: 'persuader' },
  { topic: 'brands', parent: 'social_proof', role: 'persuader' },
  { topic: 'awards', parent: 'social_proof', role: 'persuader' },
  { topic: 'gallery', parent: 'social_proof', role: 'persuader' },
  { topic: 'stats', parent: 'social_proof', role: 'persuader' },
  { topic: 'insurance', parent: 'trust', role: 'persuader' },
  { topic: 'warranty', parent: 'trust', role: 'persuader' },
  { topic: 'certifications', parent: 'trust', role: 'persuader' },
  { topic: 'security', parent: 'trust', role: 'persuader' },
  { topic: 'guarantee', parent: 'trust', role: 'persuader' },
  { topic: 'about', parent: 'trust', role: 'persuader' },
  { topic: 'team', parent: 'trust', role: 'persuader' },
  { topic: 'services', parent: 'features', role: 'persuader' },
  { topic: 'features', parent: 'features', role: 'persuader' },
  { topic: 'process', parent: 'features', role: 'persuader' },
  { topic: 'menu', parent: 'features', role: 'persuader' },
  { topic: 'inventory', parent: 'features', role: 'converter' },
  { topic: 'integrations', parent: 'features', role: 'persuader' },
  { topic: 'booking', parent: 'cta', role: 'converter' },
  { topic: 'contact_form', parent: 'cta', role: 'converter' },
  { topic: 'newsletter', parent: 'cta', role: 'converter' },
  { topic: 'hours', parent: 'cta', role: 'persuader' },
  { topic: 'location', parent: 'cta', role: 'persuader' },
  { topic: 'cta', parent: 'cta', role: 'converter' },
  { topic: 'blog', parent: 'generic', role: 'persuader' },
  { topic: 'careers', parent: 'generic', role: 'persuader' },
  { topic: 'legal', parent: 'generic', role: 'persuader' },
  { topic: 'generic', parent: 'generic', role: 'persuader' },
];

const RULE = new Map(CLASSIFIER_TOPICS.map((t) => [t.topic, t]));

function ruleFor(topic: string): TopicRule {
  return RULE.get(topic) ?? { topic: 'generic', parent: 'generic', role: 'persuader' };
}

// ORDER IS LOAD-BEARING — first hit wins, so specific must precede general:
//   * `insurance` precedes `services`, or "Insurance Approved Repairs" becomes
//     a services section on the strength of "repairs".
//   * `brands` precedes `case_study`, or "Brands We Work With" matches "work".
//   * `pricing_plans` requires real pricing context — see fix 3 in ./classify.ts.
const TOPIC_KEYWORDS: Array<[string, RegExp]> = [
  ['cookie_banner', /\bcookies?\b[^.]{0,20}\b(banner|notice|consent|policy)\b|consent banner/i],
  ['breadcrumb', /\bbreadcrumbs?\b/i],
  ['insurance', /\b(insurance|insurer|insured)\b/i],
  ['warranty', /\b(warrant(y|ies)|guarantees?|guaranteed)\b/i],
  ['certifications', /\b(certifi|accredit|licen[cs]ed)\b|approved by|iso ?\d/i],
  ['security', /\b(security|privacy|compliance|gdpr|encrypt)\b|soc ?2/i],
  ['about', /why choose|why us|about us|our story|who we are|years? (of )?(experience|serving)/i],
  ['team', /our team|meet the team|our people|our staff/i],
  ['reviews', /\b(reviews?|ratings?|testimonial)\b|what our customers say/i],
  ['brands', /\b(brands?|partners?|manufacturers?|logos)\b|we work with|trusted by|loved by/i],
  ['gallery', /\b(galler(y|ies)|photos?)\b|before and after/i],
  ['case_study', /case stud|selected work|portfolio|our projects?|recent work/i],
  ['awards', /\b(awards?|accolades?)\b/i],
  ['pricing_plans', /\b(pricing|price list|per month|\/mo|subscriptions?)\b|\bplans?\b(?=[^.]{0,40}(from|start|month|year|[$€£]))/i],
  ['quote', /get a quote|request a quote|free estimate|get an estimate/i],
  ['financing', /\b(financ(e|ing)|instal?ments?)\b|payment plan|pay monthly/i],
  ['booking', /\b(book|booking|reserve|reservation|appointments?)\b|schedule a/i],
  ['newsletter', /\b(newsletter|subscribe)\b|join our (list|mailing)|mailing list/i],
  ['contact_form', /contact us|get in touch|start a project|\benquir|\binquir|send us/i],
  ['hours', /opening hours|\bhours\b|open (mon|tue|wed|thu|fri|sat|sun)/i],
  ['location', /find us|our location|directions|where we are|visit us/i],
  ['menu', /\b(menus?|dishes)\b|our food/i],
  ['inventory', /\bbest ?sellers?\b|\b(shop|products?|collection)\b|our range|in stock/i],
  ['process', /our process|how it works|the process|what to expect|\bsteps?\b/i],
  ['services', /\b(services?|repairs?|treatments?|specialit|specialt)\b|what we (do|offer)/i],
  ['integrations', /\bintegrations?\b|works with|connects? to/i],
  ['features', /\b(features?|benefits?|capabilit)\b|what you get/i],
  ['faq', /\bfaq\b|frequently asked|common questions?/i],
  ['comparison', /\b(compare|comparison|versus)\b|\bvs\./i],
  ['blog', /\b(blog|news|articles?|insights?)\b/i],
  ['careers', /\b(careers?|jobs?)\b|join (the|our) team|we.re hiring/i],
  ['legal', /\bterms\b|privacy policy|cookie policy|\blegal\b/i],
];

/**
 * schema.org `@type` → topic. The highest-precision signal available, and free:
 * the crawler already has the HTML, and a site that publishes structured data
 * has told us what a section is rather than leaving us to infer it from copy.
 *
 * Ranked BELOW structural rules deliberately — many sites emit an Organization
 * or WebSite blob site-wide in the header or footer, and letting that outrank a
 * `<nav>` would turn every such navigation bar into an `about` section.
 */
const SCHEMA_TOPIC: Record<string, string> = {
  FAQPage: 'faq',
  Question: 'faq',
  Review: 'reviews',
  AggregateRating: 'reviews',
  Offer: 'pricing_plans',
  AggregateOffer: 'pricing_plans',
  PriceSpecification: 'pricing_plans',
  Service: 'services',
  Product: 'inventory',
  ItemList: 'inventory',
  Menu: 'menu',
  MenuSection: 'menu',
  LocalBusiness: 'location',
  PostalAddress: 'location',
  OpeningHoursSpecification: 'hours',
  BreadcrumbList: 'breadcrumb',
  ImageGallery: 'gallery',
  JobPosting: 'careers',
  BlogPosting: 'blog',
  Article: 'blog',
  Organization: 'about',
};

const TOPIC_CONTENT: Array<[string, RegExp]> = [
  ['pricing_plans', /(?:[$€£]\s?\d[\d,.]*\s*(?:\/|per\s)\s*(?:mo|month|yr|year|seat|user))|(?:\b(?:starter|basic|pro|growth|premium|enterprise)\b[^.]{0,60}[$€£]\s?\d)/i],
  ['reviews', /(?:★{2,})|(?:\b\d(?:\.\d)?\s*(?:out of|\/)\s*5\b)|(?:\brated\b)|(?:["“][^"”]{20,160}["”]\s*[—–-]\s*[A-Z][a-z]+)/],
  ['guarantee', /\b(?:money[- ]back guarantee|free returns?|returns? within|refund(?:s)? within|cancel anytime)\b/i],
  ['security', /\b(?:encrypted|soc ?2|iso ?27001|gdpr[- ]compliant)\b/i],
  ['comparison', /\b(?:vs|versus)\b\.?[^.!?]{0,80}\b(?:compare|comparison|plans?|features?|alternative)\b|\bhow (?:we|it) compares?\b/i],
];

/** Which classifier stage produced the label. Persisted as provenance (the
 *  `page_semantics.source` column distinguishes structured_data from
 *  heuristic), so it must name the stage that actually MATCHED — a section
 *  that merely CONTAINS a JSON-LD blob but was classified by its `<nav>` tag
 *  is heuristic evidence, not the site telling us what it is. */
export type ClassifierStage = 'structural' | 'structured_data' | 'keyword' | 'content' | 'fallback';

/**
 * Classify a section into a topic, its parent, and its functional role.
 * Structure and fallbacks are the shared implementation from ./classify.ts, so
 * the browser cannot disagree with the server about what a `<nav>` is.
 */
export function classifyTopic(
  f: SectionFeatures,
): TopicRule & { strength: 'strong' | 'weak'; stage: ClassifierStage } {
  const structural = structuralTopicOf(f);
  if (structural) return { ...ruleFor(structural), strength: 'strong', stage: 'structural' };

  // Stage 0: the site told us what this is. Beats every inferred keyword.
  for (const t of f.structuredTypes ?? []) {
    const topic = SCHEMA_TOPIC[t];
    if (topic) return { ...ruleFor(topic), strength: 'strong', stage: 'structured_data' };
  }

  const hay = `${f.idClass} ${f.headingText}`.toLowerCase();
  for (const [topic, re] of TOPIC_KEYWORDS) {
    if (re.test(hay)) return { ...ruleFor(topic), strength: 'strong', stage: 'keyword' };
  }
  for (const [topic, re] of TOPIC_CONTENT) {
    if (re.test(f.bodyText)) return { ...ruleFor(topic), strength: 'strong', stage: 'content' };
  }
  return { ...ruleFor(fallbackTopicOf(f)), strength: 'weak', stage: 'fallback' };
}

export type { SemanticType, SectionFeatures, TopicRule };
