/**
 * The one visible text node inside `el`, or null when there are none or
 * several. A CTA is almost always "label + icon" (<a>Let's talk<svg/></a>):
 * one text node beside child elements. That shape can take new copy by
 * changing the node's value alone, keeping the icon. "Get <span>started</span>"
 * has two text nodes and no single place the copy belongs.
 * Same rule as @sentientui/react's slot-text.ts.
 */
export function soleTextNode(el: Element): Text | null {
  // 4 = NodeFilter.SHOW_TEXT; the global isn't guaranteed outside browsers.
  const walker = el.ownerDocument.createTreeWalker(el, 4);
  let only: Text | null = null;
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if ((n.nodeValue ?? '').trim() === '') continue;
    const parent = n.parentElement?.tagName;
    if (parent === 'SCRIPT' || parent === 'STYLE' || parent === 'TEMPLATE') continue;
    if (only !== null) return null;
    only = n as Text;
  }
  return only;
}

/**
 * Whether a text version can be tested on `el` without flattening its markup:
 * a leaf, or an element with exactly one visible text node (label + icon).
 * The editor's text test was gated on leaves only, so it refused nearly every
 * real CTA — the arrow/icon beside the label made it a "container".
 */
export function canTestText(el: Element): boolean {
  return el.childElementCount === 0 || soleTextNode(el) !== null;
}

/** What applyContentText would replace — the snapshot a preview restores. */
export function currentText(el: Element): string {
  return soleTextNode(el)?.nodeValue ?? el.textContent ?? '';
}

/**
 * Put a text version's copy into `el` without flattening its markup.
 * `el.textContent = copy` destroyed every child element: a target wrapping an
 * icon + label lost the icon, and a target that WRAPS the site's <button> lost
 * the button itself — the styled control became bare text. When the target has
 * exactly one visible text node, only that node's value changes, so every
 * element and class around it survives. Otherwise (several texts, or none)
 * there is no single place the copy belongs, and textContent — the target
 * element keeps its own styling — is still the honest fallback. Idempotent:
 * after either path the target holds one text node with the copy.
 */
export function applyContentText(el: Element, text: string): void {
  const only = soleTextNode(el);
  if (only !== null) only.nodeValue = text;
  else el.textContent = text;
}
