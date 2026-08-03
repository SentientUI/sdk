import type { SlotConfigEntry } from '@sentientui/core';
import type { SnippetSlotDecl } from './config';
import { isUrlScopedOut, resolveLocatorOne } from './locator';
import { applyOps } from './ops';

type SlotResult = string | Record<string, string>;

export function applyPersonaAttributes(persona: string, band: string, doc: Document): void {
  doc.documentElement.setAttribute('data-sentient-persona', persona);
  doc.documentElement.setAttribute('data-sentient-confidence', band);
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
): void {
  for (const [slotId, decl] of Object.entries(decls)) {
    const result = results[slotId];
    if (!result || typeof result === 'string') continue;
    const targets: Element[] = decl.target
      ? Array.from(doc.querySelectorAll(decl.target))
      : [doc.documentElement];
    for (const el of targets) {
      for (const [dim, value] of Object.entries(result)) {
        if (decl.dims[dim]?.includes(value)) el.setAttribute(`data-${dim}`, value);
      }
    }
  }
}

/**
 * Safe Swap rung: apply enumerated-arm (string) slot results as a single
 * `data-sentient-arm` attribute on the declared target. The arm is validated
 * against the slot's declared `arms` list — an undeclared or unlisted arm is
 * never written. CSS (authored by the site owner) decides which prebuilt variant
 * the attribute reveals; the snippet never reorders or injects DOM.
 */
export function applySlotArms(
  results: Record<string, SlotResult>,
  decls: Record<string, SnippetSlotDecl>,
  doc: Document,
): void {
  for (const [slotId, decl] of Object.entries(decls)) {
    const result = results[slotId];
    if (typeof result !== 'string') continue; // dims results are handled elsewhere
    if (!decl.arms || !decl.arms.includes(result)) continue; // undeclared arm → no change
    const targets: Element[] = decl.target
      ? Array.from(doc.querySelectorAll(decl.target))
      : [doc.documentElement];
    for (const el of targets) el.setAttribute('data-sentient-arm', result);
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
  },
): string[] {
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
    } else if (cfg.target) {
      targets = Array.from(doc.querySelectorAll(cfg.target));
    } else {
      targets = [doc.documentElement];
    }
    // A slot that names a specific target/locator but found nothing is a miss —
    // reported so the worker can suspend a broken slot. Applies nothing either way.
    if ((cfg.locator || cfg.target) && targets.length === 0) missed.push(slotId);

    const result = slots[slotId];
    for (const el of targets) {
      if (result !== undefined) {
        if (typeof result === 'string') {
          el.setAttribute('data-sentient-arm', result);
          if (contentAndOps) opts?.onApplied?.(slotId, result, el);
        } else {
          for (const [dim, value] of Object.entries(result)) el.setAttribute(`data-${dim}`, value);
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
  return missed;
}
