import type { CompoundLocator } from './snapshot.js';

// Live-DOM twin of apps/api/src/domain/locator-from-html.ts. The two MUST stay
// in step: section_key is a hash of this object, so any divergence silently
// splits one physical section into two identities — a crawl-derived one and a
// client-derived one — and every per-section number downstream halves.
// Cross-implementation parity is locked by apps/api/src/domain/locator-parity.test.ts.
// data-sentient-id FIRST (added 2026-09-05, both generators together): it is
// the one attribute a site authors specifically to name a section for us, and
// it is exactly what hydration and redesigns do NOT rewrite. Elements with a
// unique `id` are unaffected (id outranks data attrs); for the rest the change
// moves section_key once — ingest-time fingerprint reconciliation
// (section-key-reconcile.ts) writes the alias, and no offline backfill is
// possible because pre-change locators never captured the attribute.
const STABLE_DATA_ATTRS = ['data-sentient-id', 'data-testid', 'data-test', 'data-id', 'data-name', 'data-cy'];
const FINGERPRINT_TEXT_MAX = 40;

function normalizedText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function fingerprintOf(el: Element): { tag: string; text: string } {
  return {
    tag: el.tagName.toLowerCase(),
    text: normalizedText(el).slice(0, FINGERPRINT_TEXT_MAX),
  };
}

function cssEscape(v: string): string {
  return v.replace(/["\\\]]/g, '\\$&');
}

function unique(root: ParentNode, selector: string): boolean {
  try {
    return root.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

/** Shortest unique selector: tag, tag.class, then parent-qualified, then nth-of-type chain. */
function uniqueSelector(el: Element, root: ParentNode): string | null {
  const tag = el.tagName.toLowerCase();
  if (!tag) return null;
  const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => /^[a-zA-Z][\w-]*$/.test(c));
  const candidates = [tag, ...classes.map((c) => `${tag}.${c}`)];
  for (const c of candidates) if (unique(root, c)) return c;
  const parent = el.parentElement;
  if (parent && (parent as ParentNode) !== root) {
    const parentSel = uniqueSelector(parent, root);
    if (parentSel) {
      for (const c of candidates) {
        const combined = `${parentSel} > ${c}`;
        if (unique(root, combined)) return combined;
      }
      // Element-only children: matches the server's rawTagName filter over
      // childNodes, which excludes text nodes.
      const siblings = Array.from(parent.children).filter((n) => n.tagName.toLowerCase() === tag);
      const idx = siblings.indexOf(el);
      // An nth-of-type selector is only trustworthy when it pairs with a
      // fingerprint that could actually catch drift: if every same-tag sibling
      // has identical text, the node is a true duplicate and the {tag, text}
      // check can never distinguish "still the right one" from "DOM reordered,
      // now pointing at the wrong duplicate". Refuse it rather than return a
      // false sense of precision.
      const distinguishable = siblings.some((s) => s !== el && normalizedText(s) !== normalizedText(el));
      if (idx >= 0 && distinguishable) {
        const nth = `${parentSel} > ${tag}:nth-of-type(${idx + 1})`;
        if (unique(root, nth)) return nth;
      }
    }
  }
  return null;
}

/** Build a compound locator for a live DOM element. Returns null when nothing
 *  resolves uniquely — the runtime never guesses an identity. */
export function locatorFromElement(el: Element, root: ParentNode): CompoundLocator | null {
  const fingerprint = fingerprintOf(el);
  const id = el.getAttribute('id');
  if (id && unique(root, `#${cssEscape(id)}`)) return { v: 1, id, fingerprint };
  for (const name of STABLE_DATA_ATTRS) {
    const value = el.getAttribute(name);
    if (value && unique(root, `[${name}="${cssEscape(value)}"]`)) {
      return { v: 1, dataAttr: { name, value }, fingerprint };
    }
  }
  const selector = uniqueSelector(el, root);
  if (selector) return { v: 1, selector, fingerprint };
  return null;
}
