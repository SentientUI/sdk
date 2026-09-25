import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import type { ArmEdits, RegionSkeleton } from '@sentientui/core';
import { normalizeLeafText, skeletonFingerprint } from '@sentientui/core/region';

// A served content arm is COPY, not a component. AdaptiveSlot used to render
// it as `body = config.content` — the developer's children thrown away whole —
// so an <Adaptive> wrapping a styled <button> served a bare string in a div:
// the site's button, its classes and its icon all gone (observed on Bodyshop,
// 2026-09-23; the generated arm was never approved because it looked broken).
// The copy has to land INSIDE the element the developer wrote.
//
// Stricter than the snippet's `applyContentText` fallback (textContent on the
// target): React has no target element to keep, only the developer's tree.
//   - exactly one visible text leaf → only that leaf changes; every element,
//     class, icon and sibling around it survives.
//   - anything else (zero leaves, or several) → null. Several leaves means the
//     region has structure one string cannot fill (Bodyshop's two buttons
//     flattened into a sentence, 2026-09-23); zero means the text lives where
//     the tree can't see it (`label={…}`, i18n components). The caller renders
//     children and — since phase 1 — declares the region unable to render
//     content arms (RenderCaps.content = false), so none is ever drawn.

function isTextLeaf(node: ReactNode): node is string | number {
  return (typeof node === 'string' && node.trim() !== '') || typeof node === 'number';
}

function childrenOf(el: ReactElement): ReactNode {
  const props = el.props as { children?: ReactNode; dangerouslySetInnerHTML?: unknown };
  // Raw HTML is opaque to the tree walk — its text is not a leaf we can swap,
  // and descending into `children` beside it would find nothing anyway.
  if (props.dangerouslySetInnerHTML != null) return undefined;
  return props.children;
}

export function countTextLeaves(node: ReactNode): number {
  if (isTextLeaf(node)) return 1;
  if (Array.isArray(node)) return node.reduce<number>((n, c) => n + countTextLeaves(c as ReactNode), 0);
  if (isValidElement(node)) return countTextLeaves(childrenOf(node));
  return 0;
}

/** Re-parent children onto a clone. Arrays are spread as separate arguments —
 *  the same shape JSX's static children have — so unkeyed siblings the
 *  developer wrote don't start raising key warnings just because we cloned. */
function withChildren(el: ReactElement, children: ReactNode): ReactElement {
  return Array.isArray(children) ? cloneElement(el, undefined, ...(children as ReactNode[])) : cloneElement(el, undefined, children);
}

function replaceOnlyLeaf(node: ReactNode, text: string): ReactNode {
  if (isTextLeaf(node)) return text;
  if (Array.isArray(node)) return node.map((c) => replaceOnlyLeaf(c as ReactNode, text));
  if (isValidElement(node)) {
    const inner = childrenOf(node);
    // Untouched subtrees keep their identity — no clone, no remount.
    if (countTextLeaves(inner) === 0) return node;
    return withChildren(node, replaceOnlyLeaf(inner, text));
  }
  return node;
}

/**
 * The developer's children with a content arm's copy placed inside them, or
 * null when the region doesn't have exactly one text to replace (see above).
 */
export function substituteSlotText(children: ReactNode, text: string): ReactNode | null {
  return countTextLeaves(children) === 1 ? replaceOnlyLeaf(children, text) : null;
}

// ── Per-node edits (spec 2026-09-23 §4.5, Rewrite) ──────────────────────────
// A generated `edits` arm names nodes of the region skeleton the DOM capture
// produced. React applies it over the ELEMENT TREE, not the DOM, so SSR and
// hydration render the same thing. The bridge is the leaf order: the capture
// only reports a skeleton when the tree's text leaves equal the DOM's
// (annotateSkeletonForReact), so leaf i here is leaf i there, and
// `leafToNode[i]` says which node owns it.

// A position in the tree: array indices, and 'c' for "into this element's
// children". An element's path is always followed by 'c' in its leaves' paths.
type Step = number | 'c';
type Path = Step[];

type TreeIndex = {
  leafPaths: Path[];
  texts: string[];
  elements: Map<string, ReactElement>;
};

const keyOf = (p: Path): string => p.join('/');

function indexTree(node: ReactNode, path: Path, out: TreeIndex): void {
  if (isTextLeaf(node)) {
    out.leafPaths.push(path);
    out.texts.push(normalizeLeafText(String(node)));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((c, i) => indexTree(c as ReactNode, [...path, i], out));
    return;
  }
  if (isValidElement(node)) {
    out.elements.set(keyOf(path), node);
    indexTree(childrenOf(node), [...path, 'c'], out);
  }
}

function buildIndex(children: ReactNode): TreeIndex {
  const idx: TreeIndex = { leafPaths: [], texts: [], elements: new Map() };
  indexTree(children, [], idx);
  return idx;
}

export function reactLeafTexts(children: ReactNode): string[] {
  return buildIndex(children).texts;
}

/** Same value as the DOM capture's `fp` when parity holds — computable at
 *  decide time from the tree alone, before any DOM exists. */
export function reactFingerprint(children: ReactNode): string | null {
  const t = reactLeafTexts(children);
  return t.length === 0 ? null : skeletonFingerprint(t);
}

/** Paths of every element that encloses the leaf, outermost first. */
function enclosingElements(leaf: Path): Path[] {
  const out: Path[] = [];
  leaf.forEach((s, i) => {
    if (s === 'c') out.push(leaf.slice(0, i));
  });
  return out;
}

/** Owner of each node: the deepest element enclosing all of its leaves, or
 *  null when a leaf sits directly at the root (no element to hide/restyle). */
function nodeOwners(idx: TreeIndex, leafToNode: number[]): Array<Path | null> {
  const count = leafToNode.reduce((m, n) => Math.max(m, n + 1), 0);
  const owners: Array<Path | null> = [];
  for (let k = 0; k < count; k++) {
    const lists = leafToNode.flatMap((n, i) => (n === k ? [enclosingElements(idx.leafPaths[i]!)] : []));
    if (lists.length === 0) {
      owners.push(null);
      continue;
    }
    let common = lists[0]!;
    for (const l of lists.slice(1)) {
      const keys = new Set(l.map(keyOf));
      common = common.filter((p) => keys.has(keyOf(p)));
    }
    owners.push(common.length > 0 ? common[common.length - 1]! : null);
  }
  return owners;
}

function classNameOf(el: ReactElement | undefined): string | undefined {
  const c = (el?.props as { className?: unknown } | undefined)?.className;
  return typeof c === 'string' ? c : undefined;
}

/**
 * The skeleton with React's view of it applied, or null when the tree and the
 * DOM disagree (a composite that adds, drops or reorders text; `label={…}`
 * props; i18n components) — edits addressed by leaf order would then land on
 * the wrong element, so the region is reported unaddressable instead.
 */
export function annotateSkeletonForReact(skeleton: RegionSkeleton, children: ReactNode): RegionSkeleton | null {
  const idx = buildIndex(children);
  if (idx.texts.length !== skeleton.leaves.length || idx.texts.some((t, i) => t !== skeleton.leaves[i])) return null;
  const owners = nodeOwners(idx, skeleton.leafToNode);
  const nodes = skeleton.nodes.map((n, k) => {
    const owner = owners[k];
    const el = owner ? idx.elements.get(keyOf(owner)) : undefined;
    // A host element always takes className; a composite only visibly when it
    // was handed one (it may not forward an unknown prop).
    const restylable = !!el && (typeof el.type === 'string' || classNameOf(el) !== undefined);
    return { ...n, restylable };
  });
  return { ...skeleton, nodes };
}

/**
 * The developer's children with a Rewrite arm applied, or null when this tree
 * can't take it (leaf count moved since the skeleton, an owner that can't be
 * hidden/restyled/reordered). Null means the caller renders children — and
 * the page declared its fingerprint at decide time, so a mismatch is normally
 * excluded before the draw rather than discovered here.
 */
export function applyEdits(children: ReactNode, edits: ArmEdits, leafToNode: number[]): ReactNode | null {
  const idx = buildIndex(children);
  if (idx.leafPaths.length !== leafToNode.length) return null;
  const nodeCount = leafToNode.reduce((m, n) => Math.max(m, n + 1), 0);
  for (const k of Object.keys(edits.nodes)) {
    if (!/^\d+$/.test(k) || Number(k) >= nodeCount) return null;
  }
  const owners = nodeOwners(idx, leafToNode);
  const firstLeaf = new Map<number, number>();
  leafToNode.forEach((n, i) => {
    if (!firstLeaf.has(n)) firstLeaf.set(n, i);
  });
  const leafAt = new Map(idx.leafPaths.map((p, i) => [keyOf(p), i]));

  const hidden = new Set<string>();
  const restyle = new Map<string, string>();
  let failed = false;
  for (const [ks, e] of Object.entries(edits.nodes)) {
    const k = Number(ks);
    const owner = owners[k];
    if (e.hidden) {
      if (!owner) failed = true;
      else hidden.add(keyOf(owner));
    }
    if (e.like !== undefined) {
      const src = owners[e.like];
      const target = owner ? idx.elements.get(keyOf(owner)) : undefined;
      const cls = src ? classNameOf(idx.elements.get(keyOf(src))) : undefined;
      if (!owner || cls === undefined || classNameOf(target) === undefined) failed = true;
      else restyle.set(keyOf(owner), cls);
    }
  }
  // order[g]: node indices in their new order. Applied at the array that holds
  // all of the group's owners as direct entries.
  const pendingOrders = new Map<string, number[]>(Object.entries(edits.order ?? {}));

  const rebuild = (node: ReactNode, path: Path): ReactNode => {
    if (isTextLeaf(node)) {
      const i = leafAt.get(keyOf(path));
      if (i === undefined) return node;
      const k = leafToNode[i]!;
      const text = edits.nodes[String(k)]?.text;
      if (text === undefined) return node;
      return firstLeaf.get(k) === i ? text : '';
    }
    if (Array.isArray(node)) {
      const out = node.map((c, i) => rebuild(c as ReactNode, [...path, i]));
      for (const [g, perm] of pendingOrders) {
        const positions = perm.map((k) => {
          const o = owners[k];
          if (!o || o.length !== path.length + 1 || keyOf(o.slice(0, -1)) !== keyOf(path)) return -1;
          return o[o.length - 1] as number;
        });
        if (positions.some((p) => p < 0)) continue;
        const slots = [...positions].sort((a, b) => a - b);
        const before = [...out];
        slots.forEach((slot, m) => {
          out[slot] = before[positions[m]!];
        });
        pendingOrders.delete(g);
      }
      return out;
    }
    if (isValidElement(node)) {
      const key = keyOf(path);
      if (hidden.has(key)) return null;
      const inner = childrenOf(node);
      // Untouched subtrees keep their identity — no clone, no remount.
      if (countTextLeaves(inner) === 0) return node;
      const rebuilt = rebuild(inner, [...path, 'c']);
      const cls = restyle.get(key);
      const props = cls !== undefined ? { className: cls } : undefined;
      return Array.isArray(rebuilt)
        ? cloneElement(node, props, ...(rebuilt as ReactNode[]))
        : cloneElement(node, props, rebuilt);
    }
    return node;
  };

  const out = rebuild(children, []);
  if (failed || pendingOrders.size > 0) return null;
  return out;
}
