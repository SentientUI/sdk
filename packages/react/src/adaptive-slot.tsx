'use client';
import { useEffect, useMemo, useRef, type JSX, type ReactNode } from 'react';
import { containsFormBlock } from '@sentientui/core';
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
};

/**
 * A region whose content the server may replace with a named arm — a copy
 * string or a validated Composition Block tree (registry slot config). The
 * children are the founder's baseline: they render untouched for holdout
 * traffic, unserved slots, and every error path, so the worst case is always
 * "nothing changed" (spec 2026-09-08 empty-cell-generation §3).
 */
export function AdaptiveSlot({ id, children, onFormSubmit, goal, className }: AdaptiveSlotProps): JSX.Element {
  const client = useSentient();
  const apiKey = useAdaptiveApiKey();
  const { config, arm, palette, source } = useSlotConfig(id);
  const nodeRef = useRef<HTMLDivElement | null>(null);

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
    // (use-adaptive-tokens). Field values are NOT on either write.
    client.componentGoal(id, goalName);
    client.goal(goalName, { metadata: { componentId: id, arm }, weight: 1.0, stepIndex: 0 });
  };

  // Precedence: served arm's block tree, else served content string, else the
  // developer's children. content/blocks are mutually exclusive on purpose —
  // the snippet's "content overwrites blocks' textContent" ordering hazard
  // (apply.ts) must not be reproduced here.
  let body: ReactNode = children;
  if (tree !== undefined && !formBlocked) {
    body = renderBlocks(tree, { palette, onFormSubmit, onFormGoal: fireFormGoal }) ?? children;
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
  // exposure — same contract as useAdaptiveTokens.
  const exposedArmRef = useRef<string | null>(null);
  useEffect(() => {
    if (!client || source === 'none' || source === 'override' || arm === '' || exposedArmRef.current === arm) return;
    exposedArmRef.current = arm;
    trackExposure(client, apiKey, id, arm);
  }, [client, apiKey, id, arm, source]);

  // Optional container goal (click/scroll/composite) — slot-goal shape, with
  // the same source gates as the exposure above.
  const goalKey = goal === undefined ? null : typeof goal === 'string' ? goal : JSON.stringify(goal);
  useEffect(() => {
    if (!client || !goal || source === 'override' || source === 'none') return;
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
  }, [client, id, goalKey, arm, source]);

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
