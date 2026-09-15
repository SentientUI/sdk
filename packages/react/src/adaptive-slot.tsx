'use client';
import { useEffect, useMemo, useRef, type JSX, type ReactNode } from 'react';
import { containsFormBlock, reveal } from '@sentientui/core';
import { useAdaptiveApiKey, useSentient } from './provider.js';
import { useSlotConfig } from './use-slot-config.js';
import { renderBlocks } from './blocks-render.js';
import {
  attachGoalListeners,
  goalLabelOf,
  goalValueOf,
  isDevBuild,
  normalizeGoal,
  trackExposure,
  type GoalConfig,
} from './adaptive-shared.js';
import { registerSlot } from './devtools-registry.js';

// Warn once per slot id per page lifetime, not per render.
const warnedFormSlots = new Set<string>();

export type AdaptiveSlotProps = {
  id: string;
  /** Baseline JSX — holdout, unknown personas, empty cells, every error path. */
  children: ReactNode;
  /** Receives form values when a generated form arm submits. Without it, form
   *  arms fall back to children entirely. Values never reach Sentient. */
  onFormSubmit?: (values: Record<string, string>) => void;
  /** Optional goal attached to the container (click/scroll/composite), same
   *  shape as AdaptiveGroup's. Form arms fire their own submitGoal regardless. */
  goal?: string | GoalConfig;
  className?: string;
  /** On first registration the SDK sends the region's rendered text (capped at
   *  400 chars) so dashboard-generated versions are grounded in what they
   *  replace. Set false for a slot wrapping personalized or account content —
   *  the text of THIS region is all that is ever read, never the page. */
  reportBaselineText?: boolean;
};

/**
 * @deprecated Use `<Adaptive id="…">{children}</Adaptive>` — `<Adaptive>`
 * without `variants` is this component. Kept exported because the package is
 * published; it will not be removed in a minor release.
 *
 * A region whose content the server may replace with a named arm — a copy
 * string or a validated Composition Block tree (registry slot config). The
 * children are the founder's baseline: they render untouched for holdout
 * traffic, unserved slots, and every error path, so the worst case is always
 * "nothing changed" (spec 2026-09-08 empty-cell-generation §3).
 */
export function AdaptiveSlot({
  id,
  children,
  onFormSubmit,
  goal,
  className,
  reportBaselineText = true,
}: AdaptiveSlotProps): JSX.Element {
  const client = useSentient();
  const apiKey = useAdaptiveApiKey();
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const { config, arm, palette, source } = useSlotConfig(id, {
    // Only ever read when the slot is unserved — at that moment the wrapper
    // contains exactly the baseline children this slot exists to replace.
    baselineText: reportBaselineText ? () => nodeRef.current?.textContent ?? null : undefined,
  });

  const tree = arm !== '' ? config?.blocks?.[arm] : undefined;
  // A form tree without a handler is refused WHOLE (children render instead):
  // dropping just the form node would show a section minus its call-to-action —
  // looks live, converts nothing. Same rule the snippet applies.
  const formBlocked = tree !== undefined && containsFormBlock(tree) && !onFormSubmit;

  useEffect(() => {
    if (!formBlocked || !isDevBuild() || warnedFormSlots.has(id)) return;
    warnedFormSlots.add(id);
    console.warn(
      `[sentient] AdaptiveSlot "${id}" was served a form arm but has no onFormSubmit handler — ` +
        `rendering its baseline children instead. Pass onFormSubmit to render generated forms.`,
    );
  }, [formBlocked, id]);

  const fireFormGoal = (goalName: string): void => {
    if (!client || source === 'override') return;
    // componentGoal credits the optimizer (arm resolved from slot state);
    // goal() writes the session funnel record — the slot-goal shape
    // (use-adaptive-tokens). Field values are NOT on either write. A seeded
    // (not-yet-decided) arm keeps the session goal — the visitor did convert —
    // but not the arm credit: close-out would hand it to whichever arm this
    // session's decide draws afterwards.
    if (source !== 'seeded') client.componentGoal(id, goalName);
    client.goal(goalName, { metadata: { componentId: id, arm }, weight: 1.0, stepIndex: 0 });
  };

  // Precedence: served arm's block tree, else served content string, else the
  // developer's children. content/blocks are mutually exclusive on purpose —
  // the snippet's "content overwrites blocks' textContent" ordering hazard
  // (apply.ts) must not be reproduced here.
  let body: ReactNode = children;
  // True when the served arm HAS a tree but it never reaches the page: the
  // form gate refused it, or renderBlocks returned root-level null (unknown
  // ROOT node from a newer server). The children shown then are a fallback,
  // not an assignment — the exposure gate below reads this so the arm is not
  // charged an impression it could never convert on.
  let armBlocked = false;
  if (tree !== undefined) {
    const rendered = formBlocked ? null : renderBlocks(tree, { palette, onFormSubmit, onFormGoal: fireFormGoal });
    if (rendered === null) armBlocked = true;
    else body = rendered;
  } else if (config?.content !== undefined && source !== 'none') {
    body = config.content;
  }

  // Devtools slot registry — arms come from the config's block map (the only
  // arm list the client can see for a registry slot). A slot is NOT a
  // component: registering it as one writes the wrong override channel.
  const armsKey = config?.blocks ? Object.keys(config.blocks).sort().join('|') : '';
  useEffect(() => {
    return registerSlot({ id, arms: armsKey === '' ? undefined : armsKey.split('|') });
  }, [id, armsKey]);

  // Exposure — once per (slot, arm). 'none' means the slot was never served
  // (children baseline): recording it would accrue a phantom impression that
  // can never convert. A forced arm ('override') is a preview, not an
  // exposure — same contract as useAdaptiveTokens. armBlocked is the same
  // phantom from the other direction: the arm was served but its tree never
  // rendered (form gate, unknown root block), so an exposure here would let
  // the bandit permanently bury the arm on this install for a rendering
  // failure. No baseline exposure is reported either — decide didn't assign
  // baseline, the children are just the fail-safe. 'seeded' (last visit's
  // snapshot, not yet decided this session) renders for pre-paint parity but
  // has no slot_decisions row: exposing it trained an arm the server never
  // served this session, then exposed a second arm when the decide landed.
  const exposedArmRef = useRef<string | null>(null);
  useEffect(() => {
    if (!client || source === 'none' || source === 'seeded' || source === 'override' || arm === '' || armBlocked) return;
    if (exposedArmRef.current === arm) return;
    exposedArmRef.current = arm;
    trackExposure(client, apiKey, id, arm);
  }, [client, apiKey, id, arm, source, armBlocked]);

  // Optional container goal (click/scroll/composite) — slot-goal shape, with
  // the same source gates as the exposure above. armBlocked gates here too:
  // the visitor saw the baseline children, and a goal stamped with the served
  // arm (componentGoal also resolves it from slot state) would let close-out's
  // first-pass reconciliation — goal_achieved counts as an implied exposure
  // (CONTRACTS §2) — re-mint the very phantom impression the exposure gate
  // suppressed, plus credit the arm for baseline's conversion.
  const goalKey = goal === undefined ? null : typeof goal === 'string' ? goal : JSON.stringify(goal);
  useEffect(() => {
    if (!client || !goal || source === 'override' || source === 'none' || source === 'seeded' || armBlocked) return;
    const node = nodeRef.current;
    if (!node) return;
    const label = goalLabelOf(goal);
    const declaredValue = goalValueOf(goal);
    let fired = false;
    return attachGoalListeners(
      node,
      normalizeGoal(goal),
      {
        fireGoal: () => {
          if (fired) return;
          fired = true;
          if (declaredValue !== undefined) client.componentGoal(id, label, { value: declaredValue });
          else client.componentGoal(id, label);
          client.goal(label, {
            metadata: { componentId: id, arm },
            weight: 1.0,
            stepIndex: 0,
            ...(declaredValue !== undefined ? { value: declaredValue } : {}),
          });
        },
        fireStep: (name, weight, stepIndex) => {
          client.componentGoal(id, name, { reward: weight });
          client.goal(name, { metadata: { componentId: id, arm }, weight, stepIndex });
        },
      },
      label,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, id, goalKey, arm, source, armBlocked]);

  // The adaptation reveal. Fires only when the ARM CHANGES after mount — an
  // SSR-rendered slot arrives with its arm already in the HTML, so the page was
  // always that way and animating it would be theatre on every page load. The
  // cases this does catch are the ones a visitor should notice: a client-side
  // decide resolving, and a persona upgrade re-deciding on a return visit.
  const revealedArm = useRef<string | null>(null);
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    // First observation is the mounted state, whatever it is — record and stop.
    if (revealedArm.current === null) {
      revealedArm.current = arm;
      return;
    }
    if (revealedArm.current === arm) return;
    revealedArm.current = arm;
    // `previous` is deliberately omitted: React has already swapped the
    // children by the time this effect runs, so the pre-change text is gone and
    // the arm change is itself the evidence that something changed. The arm is
    // not passed either — `dataProps` already stamps `data-sentient-arm`, and
    // writing it twice would let the two drift.
    reveal(node);
  }, [arm]);

  const dataProps = useMemo(
    () => ({ 'data-sentient-slot': id, ...(arm !== '' ? { 'data-sentient-arm': arm } : {}) }),
    [id, arm],
  );

  return (
    <div ref={nodeRef} className={className} {...dataProps}>
      {body}
    </div>
  );
}
