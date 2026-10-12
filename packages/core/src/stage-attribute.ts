/**
 * `data-sentient-stage` on <html> — the funnel stage as a theme hook
 * (docs/buying-stage-retargeting-2026-10-09.md, "How the UI changes by stage"
 * item 3). Opt-in (`stageAttributes`), like the persona attributes.
 *
 * What reaches the page is deliberately less than what /v1/decide knows:
 * - Only a STAGE, never the visit's context. A context can be an arrival class
 *   (`cart_recovery`, `product_ad`, …) derived from click IDs and campaign tags;
 *   on the page it would tell every third-party script how the visitor got
 *   here. The allowlist below is what enforces that, whatever the server sends.
 * - `customer` and `lapsed` read as `returning` unless the site asked for
 *   `'detailed'`: "has bought here" is visible to any script on the page and
 *   to anyone at a shared computer (design note, open question 4).
 */
import { STAGE_KEYS } from '@sentientui/policy';

/** `true` = coarse (`customer`/`lapsed` → `returning`); `'detailed'` = the stage as computed. */
export type StageAttributes = boolean | 'detailed';

export const STAGE_ATTRIBUTE = 'data-sentient-stage';

/** The value the page may see for `stage`, or null for "set nothing". */
export function exposedStage(stage: unknown, mode: StageAttributes | undefined): string | null {
  // `returning` is accepted as input too: it is what a snapshot written under
  // the coarse setting holds, and it stays coarse whatever the mode is now.
  if (!mode || typeof stage !== 'string' || !(stage === 'returning' || (STAGE_KEYS as readonly string[]).includes(stage))) return null;
  return mode !== 'detailed' && (stage === 'customer' || stage === 'lapsed') ? 'returning' : stage;
}

/**
 * Write (or, with null, remove) the attribute. Unlike the persona attributes
 * this OVERWRITES: the pre-paint value comes from the previous visit's
 * snapshot, and a visitor who bought since must not keep reading as `carted`
 * for the rest of this visit. The stage is frozen per visit server-side, so a
 * decide answer never changes it twice in one visit.
 */
export function setStageAttribute(value: string | null, doc: Document = document): void {
  try {
    if (value) doc.documentElement.setAttribute(STAGE_ATTRIBUTE, value);
    else doc.documentElement.removeAttribute(STAGE_ATTRIBUTE);
  } catch {
    /* fail-safe */
  }
}
