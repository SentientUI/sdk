import { PAGE_SCOPE_RE, pageScopeMatches, type CompoundLocator } from '@sentientui/core';

// Compound-locator resolution (Phase 3). Resolve id → dataAttr → selector, then
// verify against the fingerprint. Zero matches, multiple matches, or a
// fingerprint mismatch → null (the runtime NEVER guesses). URL scoping short-
// circuits when the path doesn't match.

/** Exported so goal-wiring shares this copy instead of carrying a
 *  byte-identical duplicate in the always-on bundle (audit SNIP-13). */
export function pathname(doc: Document): string {
  const loc = (doc.defaultView ?? (typeof window !== 'undefined' ? window : undefined))?.location;
  return loc?.pathname ?? '';
}

function fingerprintMatches(el: Element, fp: NonNullable<CompoundLocator['fingerprint']>): boolean {
  if (fp.tag && el.tagName.toLowerCase() !== fp.tag.toLowerCase()) return false;
  if (fp.text) {
    // Loose text match: whitespace-collapsed, case-folded, prefix-tolerant so
    // copy variants (a text op that already changed the label) don't
    // self-invalidate. Collapsing on BOTH sides is load-bearing: locators are
    // captured with `\s+`→' ' normalization (generateLocator / core's
    // fingerprintOf), while textContent of any element with nested markup
    // carries raw newlines/indentation — comparing raw-vs-collapsed made every
    // multi-node SECTION fail its own fingerprint, so the editor refused to
    // target sections ("Couldn't target this element uniquely") and the
    // visitor apply reported false locator misses on saved arrangements.
    const a = (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const b = fp.text.replace(/\s+/g, ' ').trim().toLowerCase();
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

/** Every element the locator's id → dataAttr → selector chain finds, before
 *  the uniqueness and fingerprint checks. */
function candidatesOf(loc: CompoundLocator, doc: Document): Element[] {
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
  return candidates;
}

/** Resolve a compound locator to exactly one element, or null. */
export function resolveLocatorOne(loc: CompoundLocator, doc: Document): Element | null {
  if (loc.urlMatch && !pathname(doc).includes(loc.urlMatch)) return null;
  const candidates = candidatesOf(loc, doc);
  if (candidates.length !== 1) return null; // zero or ambiguous → no change
  const el = candidates[0]!;
  if (loc.fingerprint && !fingerprintMatches(el, loc.fingerprint)) return null;
  return el;
}

/**
 * Whether a published component is ON this page for deciding purposes (the
 * page-scoped decide only asks the server about ids that are).
 *
 * A compound locator must resolve to exactly one element, as apply() will.
 * A bare selector — what the server synthesizes (`{ selector: target }`) for
 * a legacy Phase-2 string target — keeps Phase-2 semantics: apply() writes
 * EVERY match for that target (declTargets), so any match is "on". Holding it
 * to exactly-one silently stopped serving every legacy component whose
 * selector matched more than one element (`.cta` on a page with three CTAs)
 * — never decided, never applied, and never a miss either since it is
 * unscoped.
 */
export function locatorOnPage(loc: CompoundLocator, doc: Document): boolean {
  if (isUrlScopedOut(loc, doc)) return false;
  const bare = !!loc.selector && !loc.dataAttr && !loc.id && !loc.fingerprint && loc.page === undefined;
  return bare ? locatorCandidateExists(loc, doc) : resolveLocatorOne(loc, doc) !== null;
}

/** True when the locator finds at least one element that resolveLocatorOne
 *  then REJECTS (ambiguous, or the fingerprint no longer matches). That is a
 *  broken locator on whatever page it happens — the element is visibly there
 *  and we refused it — unlike plain absence, which is only a miss where the
 *  component is expected (see isLocatorMiss). */
export function locatorCandidateExists(loc: CompoundLocator, doc: Document): boolean {
  return candidatesOf(loc, doc).length > 0;
}

/**
 * Whether an UNRESOLVED locator is a health miss (the /v1/locator-miss feed that
 * auto-suspends a component). Call only after resolveLocatorOne returned null.
 *
 * Absence used to be reported unconditionally, so on a multi-page site a
 * component living only on /pricing collected a miss from every other page view
 * and was suspended as "element not found" while working. Now:
 *  - URL-scoped to another page (urlMatch) → silent, as before;
 *  - page-scoped (`page`) to ANOTHER path → silent, whatever the selector
 *    finds here. A scoped component with a generic selector (`h1`, `.hero`)
 *    used to collect a "candidate rejected" miss from every page that had one
 *    such element — the very false-suspension the scope exists to prevent;
 *  - page-scoped to THIS path and absent → miss;
 *  - unscoped: a candidate exists but was rejected → miss on any page;
 *  - otherwise (an unscoped component simply not on this page) → not a miss.
 */
export function isLocatorMiss(loc: CompoundLocator, doc: Document): boolean {
  if (isUrlScopedOut(loc, doc)) return false;
  const scoped = loc.page !== undefined && PAGE_SCOPE_RE.test(loc.page);
  if (scoped) return pageScopeMatches(loc.page, pathname(doc));
  return locatorCandidateExists(loc, doc);
}
