import type { CompoundLocator } from '@sentientui/core';

// Compound-locator resolution (Phase 3). Resolve id → dataAttr → selector, then
// verify against the fingerprint. Zero matches, multiple matches, or a
// fingerprint mismatch → null (the runtime NEVER guesses). URL scoping short-
// circuits when the path doesn't match.

function pathname(doc: Document): string {
  const loc = (doc.defaultView ?? (typeof window !== 'undefined' ? window : undefined))?.location;
  return loc?.pathname ?? '';
}

function fingerprintMatches(el: Element, fp: NonNullable<CompoundLocator['fingerprint']>): boolean {
  if (fp.tag && el.tagName.toLowerCase() !== fp.tag.toLowerCase()) return false;
  if (fp.text) {
    // Loose text match: trimmed, case-folded, prefix-tolerant so copy variants
    // (a text op that already changed the label) don't self-invalidate.
    const a = (el.textContent ?? '').trim().toLowerCase();
    const b = fp.text.trim().toLowerCase();
    if (!(a === b || a.startsWith(b) || b.startsWith(a))) return false;
  }
  return true;
}

/**
 * True when a locator is URL-scoped to a path this page is NOT on. Such a slot
 * is intentionally absent here — the caller must skip it entirely rather than
 * treat the absent target as a broken-locator miss (which would wrongly suspend
 * a slot that works fine on its own page).
 */
export function isUrlScopedOut(loc: CompoundLocator | undefined, doc: Document): boolean {
  return !!loc?.urlMatch && !pathname(doc).includes(loc.urlMatch);
}

// A safe HTML attribute name for interpolation into an attribute selector. The
// value is escaped, so the name is validated the same way rather than trusted:
// only ident chars, no selector metacharacters. All real names are `data-*`.
const SAFE_ATTR_NAME = /^[a-zA-Z_][-a-zA-Z0-9_]*$/;

/** Resolve a compound locator to exactly one element, or null. */
export function resolveLocatorOne(loc: CompoundLocator, doc: Document): Element | null {
  if (loc.urlMatch && !pathname(doc).includes(loc.urlMatch)) return null;

  let candidates: Element[] = [];
  if (loc.id) {
    const el = doc.getElementById(loc.id);
    candidates = el ? [el] : [];
  }
  if (candidates.length === 0 && loc.dataAttr?.name && SAFE_ATTR_NAME.test(loc.dataAttr.name)) {
    try {
      const value = loc.dataAttr.value.replace(/["\\]/g, '\\$&');
      candidates = Array.from(doc.querySelectorAll(`[${loc.dataAttr.name}="${value}"]`));
    } catch {
      candidates = [];
    }
  }
  if (candidates.length === 0 && loc.selector) {
    try {
      candidates = Array.from(doc.querySelectorAll(loc.selector));
    } catch {
      candidates = [];
    }
  }

  if (candidates.length !== 1) return null; // zero or ambiguous → no change
  const el = candidates[0]!;
  if (loc.fingerprint && !fingerprintMatches(el, loc.fingerprint)) return null;
  return el;
}
