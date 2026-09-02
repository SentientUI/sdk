import type { BlockNode, SitePalette, StackBlock, GridBlock } from '@sentientui/core';

// Composition Block renderer (spec 2026-08-20 §4, §6 Option B). Renders the
// bounded typed tree via document.createElement + property assignment ONLY —
// no innerHTML/outerHTML/insertAdjacentHTML exists on this path, preserving
// the snippet's "no HTML ever accepted" security property. The server has
// total-validated every tree before publish; render still fail-safes per node
// (an unknown type from a NEWER server renders nothing rather than throwing,
// so a version-skewed bundle degrades to a partial arm, never a broken page).

/** Marks an arm's rendered wrapper (direct child of the slot container). */
export const BLOCK_ARM_ATTR = 'data-sentient-block-arm';

// Derived site palette ("derived, not chosen", spec §4): sampled by the
// on-site editor from the merchant's own buttons, served with registry
// decisions and cached in the snapshot, so `emphasis: 'primary'` renders the
// site's real primary color from the pre-paint onward. Module state set by
// index.ts; absent → the neutral inherit-first defaults below.
let palette: SitePalette | null = null;
export function setBlockPalette(p: SitePalette | null | undefined): void {
  palette = p ?? null;
}
/** Marks an original child hidden by a revealed arm; value = its prior inline
 *  display, so exiting composition restores the DOM exactly. */
const ORIG_HIDDEN_ATTR = 'data-sentient-blocks-hid';

// Token → CSS maps. Neutral, inherit-first defaults on purpose: palette
// derivation (spec §4 "derived, not chosen") is Phase-2 work — until then a
// block must look plausible on any site, which means currentColor and em units,
// not brand guesses.
const GAP: Record<string, string> = { none: '0', sm: '8px', md: '16px', lg: '24px' };
const FLEX_POS: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', between: 'space-between' };
const FONT_SIZE: Record<string, string> = { sm: '0.875em', md: '1em', lg: '1.25em' };
const HEADING_SIZE: Record<string, string> = { sm: '1.25em', md: '1.5em', lg: '2em' };
const BTN_PAD: Record<string, string> = { sm: '6px 14px', md: '10px 20px', lg: '14px 28px' };
const SPACER: Record<string, string> = { sm: '8px', md: '16px', lg: '32px' };
const RATIO: Record<string, string> = { square: '1 / 1', landscape: '4 / 3', wide: '16 / 9' };
const WEIGHT: Record<string, string> = { normal: '400', medium: '500', bold: '700' };

function styled(el: HTMLElement, styles: Record<string, string | undefined>): HTMLElement {
  for (const [k, v] of Object.entries(styles)) {
    if (v !== undefined) el.style.setProperty(k, v);
  }
  return el;
}

function toneStyles(tone?: string): Record<string, string | undefined> {
  return { opacity: tone === 'muted' ? '0.7' : undefined, 'font-weight': tone === 'accent' ? '600' : undefined };
}

/** Render one node (recursively). Null for anything unrenderable — fail-safe. */
export function renderBlock(node: BlockNode, doc: Document): HTMLElement | null {
  try {
    switch (node.type) {
      case 'stack':
      case 'grid': {
        const el = doc.createElement('div');
        if (node.type === 'stack') {
          const s = node as StackBlock;
          styled(el, {
            display: 'flex', 'flex-direction': s.direction, gap: GAP[s.gap ?? 'md'],
            'align-items': s.align ? FLEX_POS[s.align] : undefined,
            'justify-content': s.justify ? FLEX_POS[s.justify] : undefined,
            'flex-wrap': s.wrap ? 'wrap' : undefined,
          });
        } else {
          const g = node as GridBlock;
          // Responsive by construction (the catalog rule — spec §5: "authored
          // responsive behaviour", merchants never author breakpoints):
          // auto-fit collapses columns on narrow screens, while the calc()
          // term keeps each item at least an exact 1/columns share, so the
          // grid can never EXCEED the intended count on wide containers. The
          // 200px floor is what triggers the collapse.
          const gap = GAP[g.gap ?? 'md']!;
          styled(el, {
            display: 'grid',
            'grid-template-columns':
              `repeat(auto-fit, minmax(max(200px, calc((100% - ${g.columns - 1} * ${gap}) / ${g.columns})), 1fr))`,
            gap,
            'align-items': g.align ? FLEX_POS[g.align] : undefined,
          });
        }
        for (const child of node.children ?? []) {
          const c = renderBlock(child, doc);
          if (c) el.appendChild(c);
        }
        return el;
      }
      case 'text': {
        const el = doc.createElement('p');
        el.textContent = node.value;
        return styled(el, {
          margin: '0', 'font-size': node.size ? FONT_SIZE[node.size] : undefined,
          'font-weight': node.weight ? WEIGHT[node.weight] : undefined,
          'text-align': node.align, ...toneStyles(node.tone),
        });
      }
      case 'heading': {
        const el = doc.createElement(`h${node.level}`);
        el.textContent = node.value;
        return styled(el, {
          margin: '0', 'font-size': HEADING_SIZE[node.size ?? 'md'], 'text-align': node.align,
        });
      }
      case 'button': {
        const el = doc.createElement('a');
        el.textContent = node.label;
        el.href = node.href;
        if (node.tag) el.setAttribute('data-sentient-tag', node.tag);
        const emphasis = node.emphasis ?? 'primary';
        return styled(el, {
          display: 'inline-block', padding: BTN_PAD[node.size ?? 'md'],
          'border-radius': palette?.radius ?? '8px',
          font: 'inherit', 'font-size': node.size ? FONT_SIZE[node.size] : undefined,
          'text-decoration': emphasis === 'ghost' ? 'underline' : 'none', cursor: 'pointer',
          background: emphasis === 'primary' ? palette?.primaryBg ?? '#111827' : 'transparent',
          color: emphasis === 'primary' ? palette?.primaryText ?? '#ffffff' : 'inherit',
          border: emphasis === 'secondary' ? '1px solid currentColor' : 'none',
        });
      }
      case 'link': {
        const el = doc.createElement('a');
        el.textContent = node.label;
        el.href = node.href;
        if (node.tag) el.setAttribute('data-sentient-tag', node.tag);
        return styled(el, { color: 'inherit', 'text-decoration': 'underline' });
      }
      case 'image': {
        const el = doc.createElement('img');
        el.src = node.src;
        el.alt = node.alt;
        return styled(el, {
          display: 'block', 'max-width': '100%',
          'aspect-ratio': node.ratio && node.ratio !== 'auto' ? RATIO[node.ratio] : undefined,
          'object-fit': node.fit, width: node.ratio && node.ratio !== 'auto' ? '100%' : undefined,
        });
      }
      case 'badge': {
        const el = doc.createElement('span');
        el.textContent = node.value;
        return styled(el, {
          display: 'inline-block', padding: '2px 10px', 'border-radius': '999px',
          'font-size': '0.75em', border: '1px solid currentColor', ...toneStyles(node.tone),
        });
      }
      case 'spacer':
        return styled(doc.createElement('div'), { height: SPACER[node.size] ?? SPACER.md });
      default:
        return null; // newer-server node type — skip, never throw
    }
  } catch {
    return null; // fail-safe
  }
}

/**
 * Option B apply (spec §6): every arm's tree pre-renders into the container as
 * a HIDDEN direct-child wrapper; the served arm's wrapper is revealed and the
 * container's ORIGINAL children are hidden (prior inline display stashed so
 * they restore exactly). A served arm WITHOUT a tree — the usual baseline —
 * reveals nothing and restores the originals. Wrappers are keyed by arm id, so
 * repeated applies (pre-paint, post-decide, reapply) toggle visibility instead
 * of re-rendering, and reveal is a reversible attribute-level change: a stale
 * snapshot's arm is silently corrected when decide answers, no re-render.
 */
export function applySlotBlocks(
  container: Element,
  blocks: Record<string, BlockNode>,
  servedArm: string | undefined,
  doc: Document,
): void {
  try {
    // Drop wrappers for arms a newer publish removed — a stale wrapper would
    // otherwise be un-revealable dead weight (and could be revealed by an even
    // staler snapshot naming its arm). Children are scanned directly rather
    // than via an attribute selector so an arm id never needs CSS escaping.
    const existing = new Set<string>();
    for (const w of Array.from(container.children)) {
      const arm = w.getAttribute(BLOCK_ARM_ATTR);
      if (arm === null) continue;
      if (blocks[arm] === undefined) w.remove();
      else existing.add(arm);
    }
    for (const [armId, tree] of Object.entries(blocks)) {
      if (existing.has(armId)) continue;
      const rendered = renderBlock(tree, doc);
      if (!rendered) continue;
      const wrapper = doc.createElement('div');
      wrapper.setAttribute(BLOCK_ARM_ATTR, armId);
      wrapper.style.display = 'none';
      wrapper.appendChild(rendered);
      container.appendChild(wrapper);
    }

    const revealing = servedArm !== undefined && blocks[servedArm] !== undefined;
    for (const child of Array.from(container.children)) {
      const arm = child.getAttribute(BLOCK_ARM_ATTR);
      const el = child as HTMLElement;
      if (arm !== null) {
        el.style.display = revealing && arm === servedArm ? '' : 'none';
      } else if (revealing) {
        if (!el.hasAttribute(ORIG_HIDDEN_ATTR)) {
          el.setAttribute(ORIG_HIDDEN_ATTR, el.style.display);
          el.style.display = 'none';
        }
      } else if (el.hasAttribute(ORIG_HIDDEN_ATTR)) {
        el.style.display = el.getAttribute(ORIG_HIDDEN_ATTR)!;
        el.removeAttribute(ORIG_HIDDEN_ATTR);
      }
    }
  } catch {
    /* fail-safe — never break the host page */
  }
}

/**
 * Reverse one container back to the merchant's own content: drop every rendered
 * arm wrapper and un-hide whatever we hid.
 */
export function restoreBlockContainer(container: Element): void {
  try {
    for (const child of Array.from(container.children)) {
      const el = child as HTMLElement;
      if (el.getAttribute(BLOCK_ARM_ATTR) !== null) {
        el.remove();
        continue;
      }
      if (el.hasAttribute(ORIG_HIDDEN_ATTR)) {
        el.style.display = el.getAttribute(ORIG_HIDDEN_ATTR)!;
        el.removeAttribute(ORIG_HIDDEN_ATTR);
      }
    }
  } catch {
    /* fail-safe — never break the host page */
  }
}

/**
 * Reverse every block container we have touched EXCEPT the ones still being
 * served.
 *
 * Blocks apply pre-paint from the snapshot, which hides the container's real
 * children. The only code that un-hid them was applySlotBlocks itself — reached
 * only when the decide response still carries `blocks` for that slot. So when a
 * merchant archived or unpublished a composition slot, a returning visitor got
 * the deleted experiment's arrangement with the merchant's own hero
 * `display:none` for the whole page view, self-healing only on the NEXT visit.
 * The same held on a decide timeout, where the stale snapshot stands.
 *
 * Sweeping by attribute means a slot that vanished entirely from the response —
 * or a response with no slotConfig at all — still gets undone.
 */
export function sweepOrphanBlocks(doc: Document, keep: ReadonlySet<Element>): void {
  try {
    const touched = new Set<Element>();
    for (const w of Array.from(doc.querySelectorAll(`[${BLOCK_ARM_ATTR}]`))) {
      if (w.parentElement) touched.add(w.parentElement);
    }
    for (const o of Array.from(doc.querySelectorAll(`[${ORIG_HIDDEN_ATTR}]`))) {
      if (o.parentElement) touched.add(o.parentElement);
    }
    for (const container of touched) {
      if (!keep.has(container)) restoreBlockContainer(container);
    }
  } catch {
    /* fail-safe */
  }
}
