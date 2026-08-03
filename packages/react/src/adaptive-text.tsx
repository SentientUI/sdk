'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ElementType } from 'react';
import type { AssignResult } from '@sentientui/core';
import { useSentient, useAdaptiveApiKey, useOnAssignment, useSessionSegment } from './provider.js';
import { attachGoalListeners, isDevBuild, normalizeGoal, type GoalConfig } from './adaptive-shared.js';
import { getDevOverride } from './dev-override.js';
import { subscribeOverridesChanged } from './override-events.js';


export type AdaptiveTextProps = {
  id: string;
  default: string;
  component?: keyof JSX.IntrinsicElements;
  className?: string;
  /**
   * Optional conversion goal to optimize this copy toward. Without it, the
   * variant is served and logged but never scored — the copy rotates and never
   * learns. Provide a goal (a name string or a GoalConfig) to make the optimizer
   * attribute conversions to the winning wording, exactly like `<Adaptive>`.
   */
  goal?: string | GoalConfig;
};

/**
 * Dashboard-managed copy for a single element. The variants are **text only** —
 * they change the wording, never the CSS, markup, or layout of the element
 * (managed variants created from the dashboard/MCP carry text, nothing else).
 * For anything structural — style, markup shape, position — write the change in
 * code with `<Adaptive>` (any JSX per variant) or use adaptive slots on no-code
 * sites. Pass `goal` to make the managed copy optimizable (see below).
 */
export function AdaptiveText({
  id,
  default: defaultText,
  component: Tag = 'span',
  className,
  goal: goalProp,
}: AdaptiveTextProps) {
  const client = useSentient();
  const apiKey = useAdaptiveApiKey();
  const onAssignment = useOnAssignment();
  const segment = useSessionSegment();
  const trackedRef = useRef<string | null>(null);
  const nodeRef = useRef<HTMLElement | null>(null);

  // Dev override parity with <Adaptive>/useAdaptive: honor
  // ?sentient_variant=id:variant and window.__sentient_overrides (devtools,
  // applyScenario, Playwright/Cypress). A forced variant is a preview — it
  // suppresses the network assign, exposure, and goals ("no events recorded,
  // weights unchanged"). Read through useSyncExternalStore (server snapshot
  // null → no hydration mismatch on a ?sentient_variant= page; client snapshot
  // synchronous → no interim assign() before the override applies on remount).
  const override = useSyncExternalStore(
    subscribeOverridesChanged,
    () => getDevOverride(id),
    () => null,
  );

  // Seed from cache synchronously so remounts don't flash back to defaultText.
  const [text, setText] = useState<string | null>(() =>
    client?.getAssignment(id, segment)?.content ?? null
  );
  const [variantId, setVariantId] = useState<string | null>(() =>
    client?.getAssignment(id, segment)?.variantId ?? null
  );

  useEffect(() => {
    if (override) return; // forced variant — no network assign
    if (!client) return;
    // Skip if content already cached; assign() re-checks internally but this avoids the async round-trip on remount.
    if (client.getAssignment(id, segment)?.content !== undefined) return;

    let cancelled = false;
    void client.assign(id).then((result: AssignResult | null) => {
      if (cancelled) return;
      if (!result) {
        if (isDevBuild()) {
          console.warn(`[sentient] <AdaptiveText id="${id}"> assignment failed — showing default text.`);
        }
        return;
      }
      setVariantId(result.variantId);
      if (result.content) setText(result.content);
    });
    return () => {
      cancelled = true;
    };
  }, [client, id, segment, override]);

  useEffect(() => {
    if (override) return; // forced variant records no exposure
    if (!client || !variantId || !apiKey) return;
    if (trackedRef.current === variantId) return;
    trackedRef.current = variantId;
    client.track({
      projectId: apiKey,
      componentId: id,
      variantId,
      eventType: 'variant_assigned',
      payload: {},
    });
    onAssignment?.(id, variantId);
  }, [client, variantId, apiKey, id, onAssignment, override]);

  // Optional goal attribution (opt-in) — mirrors <Adaptive>. Without a goal the
  // copy is served but never scored.
  const goalKey = goalProp === undefined ? '' : typeof goalProp === 'string' ? goalProp : JSON.stringify(goalProp);
  const goal = useMemo(() => (goalProp === undefined ? null : normalizeGoal(goalProp)), [goalKey]);
  const goalLabel = goalProp === undefined ? null : typeof goalProp === 'string' ? goalProp : goal!.type;
  const goalFiredRef = useRef(false);

  useEffect(() => {
    goalFiredRef.current = false;
  }, [variantId, goalKey]);

  useEffect(() => {
    if (override) return; // forced variant records no goals
    if (!client || !variantId || !apiKey || !goal || !goalLabel) return;
    const node = nodeRef.current;
    if (!node) return;
    return attachGoalListeners(node, goal, {
      fireGoal: () => {
        if (goalFiredRef.current) return;
        goalFiredRef.current = true;
        client.track({
          projectId: apiKey,
          componentId: id,
          variantId,
          eventType: 'goal_achieved',
          goalType: goalLabel,
          payload: { reward: 1.0 },
        });
        client.goal(goalLabel, { componentId: id, variantId }, 1.0, 0);
      },
      fireStep: (name, weight, stepIndex) => {
        client.track({
          projectId: apiKey,
          componentId: id,
          variantId,
          eventType: 'goal_achieved',
          goalType: name,
          payload: { reward: weight },
        });
        client.goal(name, {}, weight, stepIndex);
      },
    });
  }, [client, variantId, apiKey, id, goal, goalLabel, override]);

  // Under a forced override, show the override variant's managed copy only if
  // it happens to be cached (managed text lives server-side, so an arbitrary
  // forced variant has no client-available copy) — otherwise fall back to the
  // default. Without an override this is just the assigned/default text.
  let displayText = text ?? defaultText;
  if (override) {
    const cached = client?.getAssignment(id, segment);
    displayText = cached && cached.variantId === override ? (cached.content ?? defaultText) : defaultText;
  }

  // Cast to ElementType so a single ref callback works across every intrinsic
  // tag without exploding into the full HTML/SVG ref union.
  const Component = Tag as ElementType;
  return (
    <Component ref={(el: HTMLElement | null) => { nodeRef.current = el; }} className={className}>
      {displayText}
    </Component>
  );
}
