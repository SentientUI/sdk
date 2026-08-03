import type { CompoundLocator } from '@sentientui/core';
import { resolveLocatorOne } from '../locator';

// Compound-locator GENERATION for the on-site picker: given a clicked element,
// produce a locator that prefers stable handles (id, platform data attributes)
// and falls back to a structural CSS path, plus a fingerprint for verification.
// Pairs with resolveLocatorOne (resolution) — the picker checks the generated
// locator resolves back to exactly the picked element before offering to save.

function esc(s: string): string {
  const g = globalThis as { CSS?: { escape?: (s: string) => string } };
  if (g.CSS && typeof g.CSS.escape === 'function') return g.CSS.escape(s);
  // Minimal CSS.escape polyfill for ancient engines. A leading digit makes an id
  // selector invalid (`#2hero` throws), so escape it as the CSSOM code-point form
  // `\3N `. Per the CSS.escape spec a digit in the SECOND position also needs the
  // code-point form when the first character is `-` (so `-1x` → `-\31 x`, not the
  // invalid `-1x`), and a lone `-` must itself be escaped. Backslash-escape any
  // other non-identifier character.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const digit = c >= '0' && c <= '9';
    if ((i === 0 && digit) || (i === 1 && digit && s[0] === '-')) out += `\\3${c} `;
    else if (i === 0 && c === '-' && s.length === 1) out += `\\-`;
    else if (/[a-zA-Z0-9_-]/.test(c)) out += c;
    else out += `\\${c}`;
  }
  return out;
}

/** A short, reasonably-stable CSS path: shortcut on the nearest id, else an
 *  nth-of-type chain (bounded depth). */
function cssPath(el: Element, doc: Document): string {
  if (el.id) return `#${esc(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node !== doc.body && node !== doc.documentElement && depth < 6) {
    if (node.id) {
      parts.unshift(`#${esc(node.id)}`);
      break;
    }
    let sel = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(sel);
    node = node.parentElement;
    depth++;
  }
  return parts.join(' > ');
}

export function generateLocator(el: Element, doc: Document): CompoundLocator {
  const loc: CompoundLocator = { v: 1 };
  if (el.id) loc.id = el.id;
  for (const name of ['data-framer-name', 'data-w-id', 'data-sentient-name']) {
    const v = el.getAttribute(name);
    if (v) {
      loc.dataAttr = { name, value: v };
      break;
    }
  }
  loc.selector = cssPath(el, doc);
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  loc.fingerprint = { tag: el.tagName.toLowerCase(), ...(text ? { text } : {}) };
  return loc;
}

/** Whether the generated locator resolves to exactly the intended element —
 *  the "matches exactly 1 element" check the picker surfaces before saving. */
export function resolvesUniquely(loc: CompoundLocator, el: Element, doc: Document): boolean {
  return resolveLocatorOne(loc, doc) === el;
}
