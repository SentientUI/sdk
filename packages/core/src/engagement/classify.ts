// Semantic section classification for no-code section capture (Phase 3 §2.4).
// Pure heuristic: element → one of the graph_nodes semantic_type enum. Mirrors
// the SDK graph scanner's vocabulary so the persona × section matrix consumes
// snippet-captured sections unchanged.
//
// The classifier is split into a pure feature-based core (classifyFeatures —
// also used server-side on crawled HTML by the site-audit classification job)
// and a DOM wrapper (classifySection). Content-based patterns detect
// pricing/social-proof/trust/comparison from BODY TEXT, so div-soup pages with
// uninformative ids/classes still classify (persona-coverage spec 2026-07-23).

export type SemanticType =
  | 'pricing' | 'hero' | 'social_proof' | 'cta' | 'features'
  | 'faq' | 'comparison' | 'trust' | 'navigation' | 'generic';

/** Canonical vocabulary — mirrors the graph_nodes semantic_type CHECK enum. */
export const SEMANTIC_TYPES: readonly SemanticType[] = [
  'pricing', 'hero', 'social_proof', 'cta', 'features',
  'faq', 'comparison', 'trust', 'navigation', 'generic',
] as const;

/** Environment-agnostic section features — buildable from a browser Element or
 *  a server-parsed node (node-html-parser). */
export type SectionFeatures = {
  tag: string;        // lowercase tag name
  idClass: string;    // `${id} ${className}`
  headingText: string;
  bodyText: string;   // normalized text content, first 2000 chars
  actionCount: number;
  textLength: number;
};

// Ordered most-specific first — the first keyword hit wins.
const KEYWORDS: Array<[SemanticType, RegExp]> = [
  ['pricing', /\b(pricing|price|plans?|subscriptions?|per month|\/mo|tier)\b/i],
  ['faq', /\b(faq|frequently asked|common questions?)\b/i],
  ['comparison', /\b(compare|comparison|versus|vs\.)\b/i],
  ['social_proof', /\b(testimonial|reviews?|trusted by|loved by|customers?|logos|rated|case stud)\b/i],
  ['trust', /\b(security|guarantee|privacy|compliance|secure|gdpr|soc ?2|encrypt)\b/i],
  ['features', /\b(features?|how it works|benefits?|capabilit|what you get)\b/i],
];

// Content-evidence patterns — run against bodyText. Ordered most-specific first.
// Deliberately conservative: pricing needs per-period/plan context next to money
// so an article mentioning "$5 million" stays generic.
const CONTENT_PATTERNS: Array<[SemanticType, RegExp]> = [
  ['pricing', /(?:[$€£]\s?\d[\d,.]*\s*(?:\/|per\s)\s*(?:mo|month|yr|year|seat|user))|(?:\b(?:starter|basic|pro|growth|premium|enterprise)\b[^.]{0,60}[$€£]\s?\d)/i],
  ['social_proof', /(?:★{2,})|(?:\b\d(?:\.\d)?\s*(?:out of|\/)\s*5\b)|(?:\brated\b)|(?:["“][^"”]{20,160}["”]\s*[—–-]\s*[A-Z][a-z]+)/],
  ['trust', /\b(?:money[- ]back guarantee|refund(?:s)? within|encrypted|soc ?2|iso ?27001|gdpr[- ]compliant|cancel anytime)\b/i],
  ['comparison', /\b(?:vs|versus)\b\.?[^.!?]{0,80}\b(?:compare|comparison|plans?|features?|alternative)\b|\bhow (?:we|it) compares?\b/i],
];

function headingText(el: Element): string {
  const h = el.querySelector('h1, h2, h3');
  return (h?.textContent ?? '').slice(0, 160);
}

/**
 * Pure classification over extracted features. `strong` = keyword or content
 * evidence (trustable enough to auto-apply); `weak` = structural fallback
 * (cta/hero/navigation/generic — capture-worthy but not persona evidence).
 */
export function classifyFeatures(f: SectionFeatures): { type: SemanticType; strength: 'strong' | 'weak' } {
  if (f.tag === 'nav' || f.tag === 'footer') return { type: 'navigation', strength: 'weak' };
  const hay = `${f.idClass} ${f.headingText}`.toLowerCase();
  for (const [type, re] of KEYWORDS) {
    if (re.test(hay)) return { type, strength: 'strong' };
  }
  for (const [type, re] of CONTENT_PATTERNS) {
    if (re.test(f.bodyText)) return { type, strength: 'strong' };
  }
  if (f.actionCount >= 1 && f.textLength > 0 && f.textLength < 200) return { type: 'cta', strength: 'weak' };
  if (f.tag === 'header') return { type: 'hero', strength: 'weak' };
  if (/\b(hero|headline|banner)\b/i.test(hay)) return { type: 'hero', strength: 'weak' };
  return { type: 'generic', strength: 'weak' };
}

/** Feature extraction from a live DOM element (browser paths). */
export function featuresFromElement(el: Element): SectionFeatures {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return {
    tag: el.tagName.toLowerCase(),
    idClass: `${el.id} ${String(el.className ?? '')}`,
    headingText: headingText(el),
    bodyText: text.slice(0, 2000),
    actionCount: el.querySelectorAll('a, button, [role="button"]').length,
    textLength: text.length,
  };
}

/** Classify a page section into a semantic type (never null — falls back to
 *  'generic' so the caller can still capture attention on it). */
export function classifySection(el: Element): SemanticType {
  return classifyFeatures(featuresFromElement(el)).type;
}
