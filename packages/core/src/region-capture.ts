// DOM capture of a region skeleton (spec 2026-09-23 §4.1). Its own entry —
// `@sentientui/core/region` — so the lean core that every plain-JS install
// downloads doesn't carry ~2 KB of capture code only React and the snippet use.
import {
  MAX_SKELETON_LEAVES,
  MAX_SKELETON_NODES,
  MAX_SKELETON_TEXT,
  type RegionSkeleton,
  type SkeletonNode,
  type SkeletonRole,
} from './region-skeleton.js';
import { gradientStopsRgb, toRgb } from './css-color.js';

export function normalizeLeafText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_SKELETON_TEXT);
}

function fnv(str: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 16 hex chars over the normalized leaf texts. Text-only on purpose: React
 *  must compute the same value from its element tree at decide time, when no
 *  DOM for the baseline may exist (a served arm is on screen). */
export function skeletonFingerprint(leaves: string[]): string {
  const s = leaves.join('\u001f');
  return fnv(s, 0x811c9dc5) + fnv(s, 0x01000193 ^ 0x5bd1e995);
}


const ACTION_TAGS = new Set(['A', 'BUTTON']);
const HEADING_RE = /^H([1-6])$/;
const BLOCK_TAGS = new Set(['P', 'LI', 'LABEL', 'BLOCKQUOTE', 'FIGCAPTION', 'DT', 'DD', 'TD', 'TH']);
const LABEL_TAGS = new Set(['LABEL', 'FIGCAPTION', 'DT']);
const SKIP_PARENTS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

function isAction(el: Element): boolean {
  if (ACTION_TAGS.has(el.tagName)) return true;
  if (el.getAttribute('role') === 'button') return true;
  return el.tagName === 'INPUT' && /^(submit|button)$/i.test((el as HTMLInputElement).type);
}

function isBlock(el: Element): boolean {
  if (HEADING_RE.test(el.tagName) || BLOCK_TAGS.has(el.tagName)) return true;
  const view = el.ownerDocument.defaultView;
  const d = view ? view.getComputedStyle(el).display : '';
  return d !== '' && d !== 'inline' && d !== 'contents';
}

/** Owner of a text node: the nearest ACTION ancestor inside the region if any
 *  (a styled button wrapping a display:block span is still a button), else the
 *  nearest block ancestor, else the region root. */
function ownerOf(text: Text, root: Element): Element {
  let action: Element | null = null;
  for (let el = text.parentElement; el && el !== root.parentElement; el = el.parentElement) {
    if (isAction(el)) { action = el; break; }
    if (el === root) break;
  }
  if (action) return action;
  for (let el = text.parentElement; el; el = el.parentElement) {
    if (el === root || isBlock(el)) return el;
  }
  return root;
}

function linkOf(raw: string | null, doc: Document): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw, doc.location?.href ?? 'https://relative.invalid/');
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    return doc.location && u.origin === doc.location.origin ? u.pathname : `${u.origin}${u.pathname}`;
  } catch {
    return undefined;
  }
}

function transparent(c: string): boolean {
  return c === '' || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
}

function ambient(root: Element): { bg: string | null; alt?: string } {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (!view) return { bg: null };
  for (let el: Element | null = root; el; el = el.parentElement) {
    const cs = view.getComputedStyle(el);
    // lab()/oklch() stops (Tailwind v4) normalized, or the gradient's second
    // stop was silently dropped (css-color.ts).
    const stops = gradientStopsRgb(cs.backgroundImage, doc);
    if (stops.length > 0) return { bg: stops[0]!, ...(stops.length > 1 ? { alt: stops[stops.length - 1]! } : {}) };
    const bg = toRgb(cs.backgroundColor, doc);
    if (!transparent(bg)) return { bg };
  }
  return { bg: null };
}

/** The addressing half of a capture: which text nodes the region has, which
 *  element owns each, and the fingerprint. No computed colours, classes or
 *  roles — this is all the snippet needs on every page view (fingerprint for
 *  the decide, owners for applying edits), and keeping it separate keeps the
 *  descriptive half out of the always-on bundle. */
export type RegionAddress = { textNodes: Text[]; ownerEls: Element[]; leafToNode: number[]; leaves: string[]; fp: string };

export function regionAddress(
  root: Element,
  maxNodes = MAX_SKELETON_NODES,
): RegionAddress | { reason: 'too_large' | 'empty' } {
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.nodeValue ?? '').trim() === '') continue;
    if (SKIP_PARENTS.has(n.parentElement?.tagName ?? '')) continue;
    textNodes.push(n as Text);
    if (textNodes.length > MAX_SKELETON_LEAVES) return { reason: 'too_large' };
  }
  if (textNodes.length === 0) return { reason: 'empty' };
  const ownerEls: Element[] = [];
  const leafToNode: number[] = [];
  for (const t of textNodes) {
    const owner = ownerOf(t, root);
    let idx = ownerEls.indexOf(owner);
    if (idx === -1) { ownerEls.push(owner); idx = ownerEls.length - 1; }
    leafToNode.push(idx);
  }
  if (ownerEls.length > maxNodes) return { reason: 'too_large' };
  const leaves = textNodes.map((t) => normalizeLeafText(t.nodeValue ?? ''));
  return { textNodes, ownerEls, leafToNode, leaves, fp: skeletonFingerprint(leaves) };
}

export function captureRegionDom(
  root: Element,
  maxNodes = MAX_SKELETON_NODES,
): { skeleton: RegionSkeleton; textNodes: Text[]; ownerEls: Element[] } | { skeleton: null; reason: 'too_large' | 'empty' } {
  const addr = regionAddress(root, maxNodes);
  if (!('fp' in addr)) return { skeleton: null, reason: addr.reason };
  const { textNodes, ownerEls, leafToNode, leaves } = addr;
  const doc = root.ownerDocument;
  const view = doc.defaultView;

  const parents: Element[] = [];
  const nodes: SkeletonNode[] = ownerEls.map((el, i) => {
    const cs = view?.getComputedStyle(el);
    const parent = el.parentElement ?? root;
    let group = parents.indexOf(parent);
    if (group === -1) { parents.push(parent); group = parents.length - 1; }
    const h = HEADING_RE.exec(el.tagName);
    const role: SkeletonRole = isAction(el) ? 'action' : h ? 'heading' : LABEL_TAGS.has(el.tagName) ? 'label' : 'text';
    const text = normalizeLeafText(leaves.filter((_, li) => leafToNode[li] === i).join(' '));
    return {
      tag: el.tagName.toLowerCase(),
      role,
      ...(h ? { level: Number(h[1]) as SkeletonNode['level'] } : {}),
      text,
      classes: (el.getAttribute('class') ?? '').replace(/\s+/g, ' ').trim(),
      ...(role === 'action'
        ? {
            filled: !!cs && (!transparent(toRgb(cs.backgroundColor, root.ownerDocument)) || (cs.backgroundImage !== '' && cs.backgroundImage !== 'none')),
            ...(linkOf(el.getAttribute('href'), doc) !== undefined ? { href: linkOf(el.getAttribute('href'), doc)! } : {}),
          }
        : {}),
      color: toRgb(cs?.color, root.ownerDocument),
      group,
      restylable: true,
    };
  });
  const amb = ambient(root);
  const rootCs = view?.getComputedStyle(root);
  const skeleton: RegionSkeleton = {
    v: 1,
    root: {
      tag: root.tagName.toLowerCase(),
      classes: (root.getAttribute('class') ?? '').replace(/\s+/g, ' ').trim(),
      ambientBg: amb.bg,
      ...(amb.alt ? { ambientBgAlt: amb.alt } : {}),
      ambientText: toRgb(rootCs?.color, root.ownerDocument),
    },
    nodes,
    leaves,
    leafToNode,
    fp: skeletonFingerprint(leaves),
  };
  return { skeleton, textNodes, ownerEls };
}

export function captureRegionSkeleton(
  root: Element,
  opts?: { maxNodes?: number },
): { skeleton: RegionSkeleton } | { skeleton: null; reason: 'too_large' | 'empty' | 'unaddressable' } {
  try {
    const out = captureRegionDom(root, opts?.maxNodes);
    return out.skeleton ? { skeleton: out.skeleton } : out;
  } catch {
    return { skeleton: null, reason: 'unaddressable' };
  }
}
