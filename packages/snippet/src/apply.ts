import { containsFormBlock, type SlotConfigEntry } from '@sentientui/core';
import type { SnippetSlotDecl } from './config';
import { isUrlScopedOut, resolveLocatorOne } from './locator';
import { applyOps } from './ops';
import { applySlotBlocks, sweepOrphanBlocks } from './blocks';

type SlotResult = string | Record<string, string>;

// One guarded target resolution shared by both declared-slot passes and the
// registry cfg.target fallback (audit SNIP-4 + SNIP-17): an invalid declared
// selector must make THAT slot apply nothing, not throw out of the whole apply
// loop — the same per-slot isolation resolveSections/resolveLocatorOne already
// have. Sharing it also keeps one copy of the resolution in the bundle.
function declTargets(target: string | undefined, doc: Document): Element[] {
  if (!target) return [doc.documentElement];
  try {
    return Array.from(doc.querySelectorAll(target));
  } catch {
    return [];
  }
}

/**
 * Fired for every (element, attribute) an apply pass writes. Exists so run() can
 * reconcile the inline pre-paint script's stamps against what THIS bundle
 * considers correct: anything the inline stamped that no pass here re-wrote gets
 * reverted (see reconcilePrePaint). Nothing else consumes it, and every call
 * site passes it through optionally, so it costs nothing when absent.
 */
export type AttrSink = (el: Element, attr: string) => void;

export function applyPersonaAttributes(persona: string, band: string, doc: Document, onAttr?: AttrSink): void {
  doc.documentElement.setAttribute('data-sentient-persona', persona);
  doc.documentElement.setAttribute('data-sentient-confidence', band);
  onAttr?.(doc.documentElement, 'data-sentient-persona');
  onAttr?.(doc.documentElement, 'data-sentient-confidence');
}

/**
 * Apply per-slot dims results as data-<dim> attributes on the declared target
 * elements. Style rung only: string (enumerated-arm) results are ignored, values
 * outside the declared space are never written, and nothing is ever reordered.
 */
export function applySlotAttributes(
  results: Record<string, SlotResult>,
  decls: Record<string, SnippetSlotDecl>,
  doc: Document,
  onAttr?: AttrSink,
): void {
  for (const [slotId, decl] of Object.entries(decls)) {
    const result = results[slotId];
    if (!result || typeof result === 'string') continue;
    const targets = declTargets(decl.target, doc);
    for (const el of targets) {
      for (const [dim, value] of Object.entries(result)) {
        if (decl.dims[dim]?.includes(value)) {
          el.setAttribute(`data-${dim}`, value);
          onAttr?.(el, `data-${dim}`);
        }
      }
    }
  }
}

/**
 * Safe Swap rung: apply enumerated-arm (string) slot results as a single
 * `data-sentient-arm` attribute on the declared target. The arm is validated
 * against the slot's declared `arms` list — an undeclared or unlisted arm is
 * never written. CSS (authored by the site owner) decides which prebuilt variant
 * the attribute reveals; this path writes one attribute and nothing else — no
 * markup injection, and no move (registry ops own the sibling-move rung).
 */
export function applySlotArms(
  results: Record<string, SlotResult>,
  decls: Record<string, SnippetSlotDecl>,
  doc: Document,
  onAttr?: AttrSink,
): void {
  for (const [slotId, decl] of Object.entries(decls)) {
    const result = results[slotId];
    if (typeof result !== 'string') continue; // dims results are handled elsewhere
    if (!decl.arms || !decl.arms.includes(result)) continue; // undeclared arm → no change
    const targets = declTargets(decl.target, doc);
    for (const el of targets) {
      el.setAttribute('data-sentient-arm', result);
      onAttr?.(el, 'data-sentient-arm');
    }
  }
}

/**
 * Registry-mode apply: the server owns the declared space, so we trust the
 * per-slot `slotConfig` (target/kind/content) that came back with the decision.
 * dims result → data-<dim>; enumerated arm → data-sentient-arm; a content arm's
 * copy → `textContent` (NEVER innerHTML — no markup is ever injected). Applies
 * to the config's target, or <html> when none is given. Fail-safe per element.
 */
export function applyRegistrySlots(
  slots: Record<string, SlotResult>,
  slotConfig: Record<string, SlotConfigEntry>,
  doc: Document,
  opts?: {
    contentAndOps?: boolean;
    /** Fired once per applied arms-kind slot (string result) on the post-decide
     *  pass — the attach point for per-option behavior signals. Never fires on
     *  the pre-paint (contentAndOps:false) pass or for dims results. */
    onApplied?: (slotId: string, arm: string, el: Element) => void;
    /** Every (element, attribute) written — the inline pre-paint reconcile feed. */
    onAttr?: AttrSink;
  },
): string[] {
  const blockContainers = new Set<Element>();
  // Pre-paint (before /v1/decide returns) must apply reversible attributes only:
  // writing textContent/ops from a possibly-stale cached snapshot would flash
  // wrong copy that is never reverted if the decide call times out. The post-
  // decide reapply passes contentAndOps:true to mutate visible content.
  const contentAndOps = opts?.contentAndOps ?? true;
  const missed: string[] = [];
  for (const [slotId, cfg] of Object.entries(slotConfig)) {
    // A slot URL-scoped to another page is intentionally absent here — skip it
    // entirely so it is never reported as a broken-locator miss (which would
    // wrongly suspend a slot that works on its own page).
    if (isUrlScopedOut(cfg.locator, doc)) continue;

    // Resolution: a compound locator (Phase 3) resolves to exactly one element
    // or none (no guess); otherwise the Phase-2 bare selector matches all; else
    // <html>. A locator miss applies nothing — fail-safe.
    let targets: Element[];
    if (cfg.locator) {
      const el = resolveLocatorOne(cfg.locator, doc);
      targets = el ? [el] : [];
    } else {
      // declTargets guards the selector: a broken cfg.target yields [] and is
      // reported as a miss below (so the worker can suspend that slot) instead
      // of aborting every remaining slot in this loop (audit SNIP-4).
      targets = declTargets(cfg.target, doc);
    }
    // A slot that names a specific target/locator but found nothing is a miss —
    // reported so the worker can suspend a broken slot. Applies nothing either way.
    if ((cfg.locator || cfg.target) && targets.length === 0) missed.push(slotId);

    const result = slots[slotId];
    for (const el of targets) {
      if (result !== undefined) {
        if (typeof result === 'string') {
          el.setAttribute('data-sentient-arm', result);
          opts?.onAttr?.(el, 'data-sentient-arm');
          if (contentAndOps) opts?.onApplied?.(slotId, result, el);
        } else {
          for (const [dim, value] of Object.entries(result)) {
            el.setAttribute(`data-${dim}`, value);
            opts?.onAttr?.(el, `data-${dim}`);
          }
        }
      }
      // Composition Blocks apply on BOTH passes, pre-paint included: rendering
      // every arm hidden and revealing by arm is precisely the reversible
      // mechanism that makes structural variants pre-paint safe (Option B,
      // composition spec §6) — a stale snapshot's reveal is corrected by the
      // post-decide toggle, no re-render and no wrong-copy wedge.
      // Belt and braces on the composition spec's §12 hard stop. The server
      // already withholds `blocks` for automation-flagged sessions, but that
      // flag is set at session ingest and a crawler that never got a session
      // (or an SSR/snapshot path) could still reach here. Option B hides the
      // merchant's own content behind hidden arms, which is a cloaking signal —
      // so when the client can see it is automation, leave the page alone.
      if (cfg.blocks && !isLikelyAutomation(doc)) {
        // The snippet cannot render forms yet. Dropping just the form node
        // (renderBlock's unknown-type skip) would reveal a section minus its
        // call-to-action — looks live, converts nothing — so a tree containing
        // a form is refused WHOLE: filtered out BEFORE applySlotBlocks, which
        // means no wrapper is created AND the reveal check cannot hide the
        // originals with nothing to show for the served arm.
        const renderable = Object.fromEntries(
          Object.entries(cfg.blocks).filter(([, tree]) => !containsFormBlock(tree)),
        );
        if (Object.keys(renderable).length > 0) {
          applySlotBlocks(el, renderable, typeof result === 'string' ? result : undefined, doc);
          blockContainers.add(el);
        }
      }
      if (!contentAndOps) continue;
      // Phase-2 content, then Phase-3 ops (ops.text wins if both set).
      if (typeof cfg.content === 'string') el.textContent = cfg.content;
      if (cfg.ops) {
        const r = applyOps(el, cfg.ops, slotId, doc);
        if (r.anchorMiss && !missed.includes(slotId)) missed.push(slotId);
      }
    }
  }
  // Anything we previously turned into a composition container but are no
  // longer serving must be put back. Without this an archived slot left the
  // merchant's own section hidden for the rest of the page view.
  sweepOrphanBlocks(doc, blockContainers);
  return missed;
}

/**
 * Cheap client-side automation check for the block path only.
 *
 * Deliberately narrow: `navigator.webdriver` plus the crawler UA tokens the
 * server already classifies on. This is NOT the billing/training signal (the
 * server owns that) — it exists so structural DOM changes that hide the
 * merchant's own content never run for something that indexes pages.
 */
const AUTOMATION_UA_RE =
  /bot|crawler|spider|crawling|googlebot|bingbot|duckduckbot|baiduspider|yandexbot|slurp|gptbot|claudebot|anthropic|perplexity|ccbot|applebot|headlesschrome/i;

function isLikelyAutomation(doc: Document): boolean {
  try {
    const nav = (doc.defaultView ?? (typeof window !== 'undefined' ? window : undefined))?.navigator;
    if (!nav) return false;
    if (nav.webdriver === true) return true;
    return AUTOMATION_UA_RE.test(nav.userAgent ?? '');
  } catch {
    return false; // never let the check itself break application
  }
}
