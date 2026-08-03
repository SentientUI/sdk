import type { SlotOps } from '@sentientui/core';
import { resolveLocatorOne } from './locator';
import { CSS_PROP, cssValueSafe } from './css-guard';

// Bounded ops apply engine (Phase 3). Applies a server-validated `SlotOps` to an
// element: text → textContent (NEVER innerHTML); https-only href/src/alt; and a
// whitelisted style set + hidden via a single generated stylesheet using
// `!important` (required to beat Webflow/Framer inline styles — acceptable
// because the property set is bounded and user-authored). No arbitrary CSS/JS.
//
// The CSS whitelist (CSS_PROP) and value guard (cssValueSafe) live in ./css-guard
// so the editor shares the exact same rules — see that file for why they were
// unified.

const HTTPS = /^https:\/\//i;

/** slotId → generated rule body. Rewritten wholesale on each apply so reapply()
 *  after SPA navigation never duplicates or leaks rules. */
const opsRules = new Map<string, string>();
let styleEl: HTMLStyleElement | null = null;

/** Test/reset hook. */
export function resetOpsSheet(): void {
  opsRules.clear();
  styleEl = null;
}

function cssId(slotId: string): string {
  return slotId.replace(/["\\]/g, '\\$&');
}

function writeSheet(doc: Document): void {
  if (!styleEl || !styleEl.isConnected) {
    styleEl = doc.querySelector('style[data-sentient-ops]');
    if (!styleEl) {
      styleEl = doc.createElement('style');
      styleEl.setAttribute('data-sentient-ops', '');
      (doc.head ?? doc.documentElement).appendChild(styleEl);
    }
  }
  styleEl.textContent = [...opsRules.entries()]
    .map(([slotId, body]) => `[data-snt-e="${cssId(slotId)}"]{${body}}`)
    .join('\n');
}

/** Apply bounded ops to `el`, keyed by `slotId` for the generated stylesheet.
 *  Returns `{ anchorMiss }` so the caller can report a drifted move-anchor to
 *  the slot-health check. */
export function applyOps(el: Element, ops: SlotOps, slotId: string, doc: Document): { anchorMiss: boolean } {
  let anchorMiss = false;
  const moveLoc = ops.moveBefore ?? ops.moveAfter;
  if (moveLoc) {
    // Reorder: anchor must resolve uniquely, be a sibling, and not be the
    // element itself — anything else applies nothing and reports a miss so the
    // slot-health check can suspend a drifted slot. insertBefore is idempotent.
    const anchor = resolveLocatorOne(moveLoc, doc);
    if (!anchor || anchor === el || anchor.parentElement !== el.parentElement || !el.parentElement) {
      anchorMiss = true;
    } else if (ops.moveBefore) {
      el.parentElement.insertBefore(el, anchor);
    } else {
      el.parentElement.insertBefore(el, anchor.nextSibling);
    }
  }

  if (typeof ops.text === 'string') el.textContent = ops.text; // never innerHTML
  if (typeof ops.href === 'string' && HTTPS.test(ops.href)) el.setAttribute('href', ops.href);
  if (typeof ops.imageSrc === 'string' && HTTPS.test(ops.imageSrc)) el.setAttribute('src', ops.imageSrc);
  if (typeof ops.imageAlt === 'string') el.setAttribute('alt', ops.imageAlt);

  const rules: string[] = [];
  if (ops.hidden) rules.push('display:none !important');
  if (ops.style) {
    for (const [k, v] of Object.entries(ops.style)) {
      const prop = CSS_PROP[k];
      if (prop && typeof v === 'string' && cssValueSafe(v)) rules.push(`${prop}:${v.trim()} !important`);
    }
  }
  if (rules.length > 0) {
    el.setAttribute('data-snt-e', slotId);
    opsRules.set(slotId, rules.join(';'));
    writeSheet(doc);
  }

  return { anchorMiss };
}
