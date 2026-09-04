// Semantic section classification for no-code section capture (Phase 3 §2.4).
// Pure heuristic: element → one of the graph_nodes semantic_type enum. Mirrors
// the SDK graph scanner's vocabulary so the persona × section matrix consumes
// snippet-captured sections unchanged.
//
// SPLIT (Phase 2b, spec 2026-09-04). This module is the BROWSER-SAFE core:
// structural rules, the small parent-level keyword table, and the fallbacks.
// The rich ~40-topic vocabulary lives in ./topics.ts, which only the server
// imports — shipping it here cost 1.5 KB gzip in every bundle (7% of the
// always-on snippet) for a layer the browser never reads, since classifySection
// returns only the parent.
//
// Both paths share structuralTopicOf/fallbackTopicOf, so the three fixes below
// apply identically on client and server; only vocabulary richness differs.
//
// Fixes, each reproduced against the shipped classifier before being changed:
//   1. structural before the converter fallback — `<div class="navbar">` used
//      to become `cta`, because `navigation` was reachable only via tag
//      nav/footer.
//   2. hero before the converter fallback — the cta rule sat above both hero
//      rules, so a `<header>` with a button and <200 chars could never be hero.
//   3. tightened pricing/social keywords — `plans?` and `customers?` fired on
//      unrelated copy AND were `strong`, so they auto-applied at confidence 0.9
//      and were never sent to the LLM fallback.

export type SemanticType =
  | 'pricing' | 'hero' | 'social_proof' | 'cta' | 'features'
  | 'faq' | 'comparison' | 'trust' | 'navigation' | 'generic';

export type SectionRole = 'converter' | 'persuader' | 'structural';

/** Canonical vocabulary — mirrors the graph_nodes semantic_type CHECK enum. */
export const SEMANTIC_TYPES: readonly SemanticType[] = [
  'pricing', 'hero', 'social_proof', 'cta', 'features',
  'faq', 'comparison', 'trust', 'navigation', 'generic',
] as const;

export type TopicRule = { topic: string; parent: SemanticType; role: SectionRole };

/** Environment-agnostic section features — buildable from a browser Element or
 *  a server-parsed node (node-html-parser). */
export type SectionFeatures = {
  tag: string;        // lowercase tag name
  idClass: string;    // `${id} ${className}`
  headingText: string;
  bodyText: string;   // normalized text content, first 2000 chars
  actionCount: number;
  textLength: number;
  /** ARIA landmark role, when the element declares one. Optional so every
   *  existing caller keeps compiling; a page that uses landmarks gives a
   *  high-precision signal for free, which the old classifier ignored — it
   *  tested membership of SEMANTIC_TYPES, so only role="navigation" ever hit
   *  and role="banner"/"contentinfo" were discarded. */
  ariaRole?: string;
  /** schema.org `@type` values found in `<script type="application/ld+json">`
   *  INSIDE this section. Highest-precision signal available and free to
   *  collect — the crawler already has the HTML. Type-only here; the
   *  `@type` → topic table is server-side in ./topics.ts, since the browser
   *  never reads the topic layer and the snippet has ~200 bytes of margin. */
  structuredTypes?: string[];
};

// ARIA landmark → topic. Structural facts, not guesses.
const ARIA_TOPIC: Record<string, string> = {
  banner: 'hero',
  navigation: 'navigation',
  contentinfo: 'footer',
};

/**
 * Structural identification, shared by the browser and server classifiers.
 * Returns a topic name, or null when the section is not structural furniture.
 * Everything matched here is definitive (tag or authored marker), so callers
 * treat it as `strong`.
 */
export function structuralTopicOf(f: SectionFeatures): string | null {
  const aria = f.ariaRole ? ARIA_TOPIC[f.ariaRole.toLowerCase()] : undefined;
  if (aria) return aria;
  if (f.tag === 'nav') return 'navigation';
  if (f.tag === 'footer') return 'footer';
  // A page-level <header> IS the banner landmark (HTML-AAM maps it to
  // role="banner", which this function already treats as hero), so it is a
  // structural fact rather than a keyword guess. Without this, a header whose
  // headline happens to contain a content word loses to the keyword table:
  // "We build brands that move" scored social_proof and "Winter collection"
  // scored features, purely on words inside the hero copy.
  if (f.tag === 'header') return 'hero';
  const hay = `${f.idClass} ${f.headingText}`.toLowerCase();
  if (/\b(navbar|nav-bar|navigation|site-nav|main-nav|topbar|footer)\b/.test(hay)) {
    return /footer/.test(hay) ? 'footer' : 'navigation';
  }
  // Explicit authoring marker beats any inferred keyword, and is matched on
  // idClass ONLY: a `<header class="hero">` headlined "Expert Car Repair" is a
  // hero, not a services section — but matching "hero" in heading text would
  // also catch "Hero of the story".
  if (/\b(hero|masthead|jumbotron)\b/i.test(f.idClass)) return 'hero';
  return null;
}

/**
 * Last-resort classification once no keyword or content evidence matched.
 * Hero is checked BEFORE the converter fallback — fix 2 above.
 */
export function fallbackTopicOf(f: SectionFeatures): string {
  // `tag === 'header'` is handled in structuralTopicOf, which runs first.
  if (f.actionCount >= 1 && f.textLength > 0 && f.textLength < 200) return 'cta';
  return 'generic';
}

// Parent-level keyword table for the BROWSER path. Deliberately close to the
// original size — the rich topic vocabulary is in ./topics.ts. `plans?` now
// requires adjacent pricing context, and bare `customers?` is gone (it fired on
// navigation furniture like a "Customer Service" footer block).
const KEYWORDS: Array<[SemanticType, RegExp]> = [
  ['pricing', /\b(pricing|price list|per month|\/mo|subscriptions?)\b|\bplans?\b(?=[^.]{0,40}(from|start|month|year|[$€£]))/i],
  ['faq', /\bfaq\b|frequently asked|common questions?/i],
  ['comparison', /\b(compare|comparison|versus)\b|\bvs\./i],
  ['social_proof', /\b(reviews?|ratings?|testimonial|brands?|galler(y|ies)|logos)\b|trusted by|loved by|case stud|what our customers say/i],
  ['trust', /\b(insurance|warrant(y|ies)|guarantees?|certifi|accredit|security|privacy|compliance|gdpr|encrypt)\b|why choose|about us|our team/i],
  ['cta', /\b(book|booking|reserve|appointments?|newsletter|subscribe)\b|contact us|get in touch|opening hours/i],
  ['features', /\b(features?|benefits?|capabilit|services?|repairs?|menus?|products?)\b|how it works|our process|what we (do|offer)|what you get/i],
];

// Content-evidence patterns — run against bodyText when the heading gave us
// nothing. Deliberately conservative: pricing needs per-period/plan context next
// to money so an article mentioning "$5 million" stays generic.
export const CONTENT_PATTERNS: Array<[SemanticType, RegExp]> = [
  ['pricing', /(?:[$€£]\s?\d[\d,.]*\s*(?:\/|per\s)\s*(?:mo|month|yr|year|seat|user))|(?:\b(?:starter|basic|pro|growth|premium|enterprise)\b[^.]{0,60}[$€£]\s?\d)/i],
  ['social_proof', /(?:★{2,})|(?:\b\d(?:\.\d)?\s*(?:out of|\/)\s*5\b)|(?:\brated\b)|(?:["“][^"”]{20,160}["”]\s*[—–-]\s*[A-Z][a-z]+)/],
  ['trust', /\b(?:money[- ]back guarantee|free returns?|returns? within|refund(?:s)? within|encrypted|soc ?2|iso ?27001|gdpr[- ]compliant|cancel anytime)\b/i],
  ['comparison', /\b(?:vs|versus)\b\.?[^.!?]{0,80}\b(?:compare|comparison|plans?|features?|alternative)\b|\bhow (?:we|it) compares?\b/i],
];

/** Parent for the handful of topics the shared structural/fallback helpers
 *  emit. The server maps the full vocabulary via CLASSIFIER_TOPICS instead. */
const SHARED_TOPIC_PARENT: Record<string, SemanticType> = {
  navigation: 'navigation',
  footer: 'navigation',
  hero: 'hero',
  cta: 'cta',
  generic: 'generic',
};

function headingText(el: Element): string {
  const h = el.querySelector('h1, h2, h3');
  return (h?.textContent ?? '').slice(0, 160);
}

/**
 * Pure classification over extracted features. `strong` = keyword, content, or
 * structural evidence (trustable enough to auto-apply); `weak` = a fallback
 * guess (hero/cta/generic — capture-worthy but not persona evidence).
 */
export function classifyFeatures(f: SectionFeatures): { type: SemanticType; strength: 'strong' | 'weak' } {
  const structural = structuralTopicOf(f);
  if (structural) return { type: SHARED_TOPIC_PARENT[structural] ?? 'generic', strength: 'strong' };

  const hay = `${f.idClass} ${f.headingText}`.toLowerCase();
  for (const [type, re] of KEYWORDS) if (re.test(hay)) return { type, strength: 'strong' };
  for (const [type, re] of CONTENT_PATTERNS) if (re.test(f.bodyText)) return { type, strength: 'strong' };

  const fb = fallbackTopicOf(f);
  return { type: SHARED_TOPIC_PARENT[fb] ?? 'generic', strength: 'weak' };
}

/** Feature extraction from a live DOM element (browser paths). */
export function featuresFromElement(el: Element): SectionFeatures {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const role = el.getAttribute('role');
  return {
    tag: el.tagName.toLowerCase(),
    idClass: `${el.id} ${String(el.className ?? '')}`,
    headingText: headingText(el),
    bodyText: text.slice(0, 2000),
    actionCount: el.querySelectorAll('a, button, [role="button"]').length,
    textLength: text.length,
    ...(role ? { ariaRole: role } : {}),
  };
}

/** Classify a page section into a semantic type (never null — falls back to
 *  'generic' so the caller can still capture attention on it). */
export function classifySection(el: Element): SemanticType {
  return classifyFeatures(featuresFromElement(el)).type;
}
