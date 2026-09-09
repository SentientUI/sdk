/**
 * The section-reorder move computation, extracted so it exists exactly once as
 * behaviour and twice as code.
 *
 * The bundle calls this. The inline pre-paint script (`renderSnippetPrePaintScript`
 * in @sentientui/core) carries a hand-minified copy of the same algorithm, because
 * it must run with zero bytes downloaded. `layout-order.test.ts` runs BOTH against
 * one fixture table, so a drift between them makes a test red rather than a page
 * wrong.
 *
 * Pure: it decides the moves, it does not perform them.
 */

export type ReorderMove = {
  /** The element to move. */
  el: Element;
  /** The sibling to insert it before (`parent.insertBefore(el, before)`). */
  before: Element;
};

/**
 * Plan the successive-insertBefore moves that put `order`'s elements into
 * `order`'s sequence, or return null when the bounds don't hold.
 *
 * Bounds (the registry-locator "no guess" rule extended to whole-page order —
 * any mismatch applies NOTHING, so a stale snapshot or an edited `sections`
 * config can never wedge a half-reordered page):
 *  - at least two ids,
 *  - every id resolves, to a DISTINCT element (two selectors that happen to hit
 *    the same node are as ambiguous as one selector hitting two nodes),
 *  - the resolved set is exactly the order's set (no extras, no missing),
 *  - all of them share one parent.
 *
 * The returned moves are computed against a simulated sibling order, so callers
 * can apply them verbatim without re-deriving anything. An already-ordered
 * prefix produces no moves at all, which is what makes reapply() idempotent.
 */
export function planReorder(
  order: string[] | null | undefined,
  resolved: Map<string, Element>,
): ReorderMove[] | null {
  if (!order || order.length < 2) return null;
  if (resolved.size !== order.length) return null;

  const els: Element[] = [];
  for (const id of order) {
    const el = resolved.get(id);
    // Missing id, or a duplicate id/element: either way we are not looking at a
    // clean permutation of distinct siblings.
    if (!el || els.includes(el)) return null;
    els.push(el);
  }

  const parent = els[0]!.parentNode;
  if (!parent) return null;
  if (!els.every((el) => el.parentNode === parent)) return null;

  // domOrder tracks the sections' current relative order; step i places the
  // wanted element into the i-th section position.
  const domOrder = els
    .slice()
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const moves: ReorderMove[] = [];
  for (let i = 0; i < els.length; i++) {
    const want = els[i]!;
    if (domOrder[i] === want) continue;
    moves.push({ el: want, before: domOrder[i]! });
    domOrder.splice(domOrder.indexOf(want), 1);
    domOrder.splice(i, 0, want);
  }
  return moves;
}
