import type { ArmEdits } from '@sentientui/core';
import { regionAddress } from '@sentientui/core/region';

// Rewrite arms in the snippet (spec 2026-09-23 §4.5). An `edits` arm names
// nodes of the region skeleton; this applies it to the site's own elements —
// new words in the existing <a>, a class list borrowed from a sibling, a
// sibling moved — so nothing is ever styled by us. Never innerHTML.
//
// The served arm carries the fingerprint it was written against. The region
// is captured on first sight and compared: a page whose markup has drifted
// since the skeleton was taken gets 'mismatch' and is left untouched (the
// caller reports drift), instead of edits landing on the wrong element.

type Baseline = {
  fp: string;
  leafToNode: number[];
  textNodes: Text[];
  ownerEls: Element[];
  classes: string[];
};

// Captured once per element: after the first apply the DOM no longer matches
// the baseline fingerprint, and SPA reapplies must re-run against the same
// refs rather than recapturing a page we already edited.
const baselines = new WeakMap<Element, Baseline>();

function sameArray(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function applyEdits(
  el: Element,
  edits: ArmEdits,
  skeleton: { fp: string; leafToNode: number[] },
): 'applied' | 'mismatch' {
  let base = baselines.get(el);
  if (!base) {
    const cap = regionAddress(el);
    if (!('fp' in cap)) return 'mismatch';
    base = {
      fp: cap.fp,
      leafToNode: cap.leafToNode,
      textNodes: cap.textNodes,
      ownerEls: cap.ownerEls,
      // Taken before any swap: a two-way emphasis swap must read both
      // originals, and a reapply must not read classes we already moved.
      classes: cap.ownerEls.map((o) => o.getAttribute('class') ?? ''),
    };
    if (base.fp !== skeleton.fp || !sameArray(base.leafToNode, skeleton.leafToNode)) return 'mismatch';
    baselines.set(el, base);
  } else if (base.fp !== skeleton.fp || !sameArray(base.leafToNode, skeleton.leafToNode)) {
    return 'mismatch';
  }
  const b = base;

  for (const [ks, e] of Object.entries(edits.nodes)) {
    const k = Number(ks);
    const owner = b.ownerEls[k];
    if (!owner) continue;
    if (typeof e.text === 'string') {
      let first = true;
      b.leafToNode.forEach((n, i) => {
        if (n !== k) return;
        b.textNodes[i]!.nodeValue = first ? e.text! : '';
        first = false;
      });
    }
    if (e.like !== undefined && b.classes[e.like] !== undefined) owner.setAttribute('class', b.classes[e.like]!);
    // Inline !important, not a generated rule: the element is the site's own
    // and one declaration is all hiding needs — no CSS string is ever built.
    if (e.hidden) (owner as HTMLElement).style?.setProperty('display', 'none', 'important');
  }

  // order[g]: node indices in their new order. The result depends only on
  // which elements are in the group, not on where they are now, so a reapply
  // on an already-reordered region is a no-op.
  for (const perm of Object.values(edits.order ?? {})) {
    const els = perm.map((k) => b.ownerEls[k]).filter((x): x is Element => !!x);
    const parent = els[0]?.parentElement;
    if (!parent || els.length !== perm.length || els.some((x) => x.parentElement !== parent)) continue;
    const members = new Set(els);
    let m = 0;
    const desired = Array.from(parent.children).map((c) => (members.has(c) ? els[m++]! : c));
    desired.forEach((c, i) => {
      if (parent.children[i] !== c) parent.insertBefore(c, parent.children[i] ?? null);
    });
  }
  return 'applied';
}
