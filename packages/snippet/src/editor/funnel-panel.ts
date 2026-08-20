// Funnel authoring helpers for the editor overlay (spec §7.3). Pure logic
// only — index.ts owns the DOM wiring — so ordering/validation is testable
// without a browser. Lives in the LAZY editor bundle: zero bytes on the
// always-on snippet path.

export type EditorFunnel = {
  funnel_id: string;
  display_name: string;
  status: string;
  steps: Array<{ step_index: number; goal_id: string }>;
};

export type EditorGoal = { goal_id: string; display_name: string; status: string };

/** One list row: "Checkout — 3 steps (draft)". */
export function funnelSummaryLine(f: EditorFunnel): string {
  const n = f.steps.length;
  const suffix = f.status === 'active' ? '' : ` (${f.status})`;
  return `${f.display_name} — ${n} step${n === 1 ? '' : 's'}${suffix}`;
}

/** Step-picker options for the assign flow: "1. Added to cart". */
export function stepOptions(f: EditorFunnel, goalNames: ReadonlyMap<string, string>): Array<{ value: number; label: string }> {
  return f.steps.map((s) => ({
    value: s.step_index,
    label: `${s.step_index + 1}. ${goalNames.get(s.goal_id) ?? s.goal_id}`,
  }));
}

/**
 * Toggle a goal in the ordered step selection: absent → appended (order of
 * clicking IS the funnel order), present → removed. Returns a new array.
 */
export function toggleStepSelection(selection: readonly string[], goalId: string): string[] {
  return selection.includes(goalId) ? selection.filter((g) => g !== goalId) : [...selection, goalId];
}

/** Slugify a funnel name into its stable id (mirrors the server's FUNNEL_ID shape). */
export function deriveFunnelId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'funnel';
}

/** Validate + build the draft payload for POST /v1/editor/funnels/:funnelId. */
export function buildDraftPayload(
  name: string,
  orderedGoalIds: readonly string[],
): { ok: true; funnelId: string; body: { displayName: string; steps: Array<{ goalId: string }> } } | { ok: false; error: string } {
  const displayName = name.trim();
  if (!displayName) return { ok: false, error: 'Give the funnel a name.' };
  if (orderedGoalIds.length < 2) return { ok: false, error: 'Pick at least 2 goals — a funnel is a sequence.' };
  if (orderedGoalIds.length > 12) return { ok: false, error: 'A funnel can have at most 12 steps.' };
  return {
    ok: true,
    funnelId: deriveFunnelId(displayName),
    body: { displayName: displayName.slice(0, 128), steps: orderedGoalIds.map((goalId) => ({ goalId })) },
  };
}
