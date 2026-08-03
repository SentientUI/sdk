import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { attachMicroSignalDetectors, type ComponentGoalOptions } from '@sentientui/core';
import { useAdaptiveApiKey, useSentient } from './provider.js';
import { useAssignment } from './use-assignment.js';
import { registerComponent } from './devtools-registry.js';
import {
  attachGoalListeners,
  goalLabelOf,
  isDevBuild,
  normalizeGoal,
  trackExposure,
  type GoalConfig,
} from './adaptive-shared.js';

export type UseAdaptiveBind = {
  ref: (el: HTMLElement | null) => void;
  'data-sentient-id': string;
  'data-sentient-variant': string;
};

export type UseAdaptiveResult<T> = {
  variant: string;
  value: T;
  /** Spread on the rendered element — wires exposure, goal listeners, and micro-signals. */
  bind: UseAdaptiveBind;
  fireGoal: (goalType?: string, opts?: ComponentGoalOptions) => void;
};

const warnedUnbound = new Set<string>();

/**
 * Rung 2 — headless, measurement-complete variant swap. Supersedes
 * `useAssignment` (which selects a variant but wires no measurement).
 *
 * `goal` is REQUIRED: without one the optimizer accumulates exposures with
 * zero rewards and cannot learn. `bind` MUST be attached to the rendered
 * element — dev mode warns loudly when a slot renders unbound.
 *
 * ```tsx
 * const { value, bind } = useAdaptive('buy-box', {
 *   variants: { calm: <CalmBuyBox/>, urgent: <UrgentBuyBox/> },  // first key = baseline
 *   goal: 'buy_click',
 * });
 * return <div {...bind}>{value}</div>;
 * ```
 */
export function useAdaptive<T>(
  id: string,
  config: { variants: Record<string, T>; goal: string | GoalConfig },
): UseAdaptiveResult<T> {
  if (isDevBuild() && !config.goal) {
    throw new Error(
      `[sentient] useAdaptive("${id}"): a goal is required — without one the optimizer accumulates exposures with no rewards and cannot learn. Pass e.g. goal: 'buy_click'.`,
    );
  }

  const client = useSentient();
  const apiKey = useAdaptiveApiKey();
  // Freeze the variant-id array on the KEY SET (same convention as <Adaptive> /
  // AdaptiveGroup / useAdaptiveTokens): stable across renders for the same keys
  // yet updates if the declared set changes. Declared space is normally fixed
  // per slot id for a session.
  const variantKey = Object.keys(config.variants).join(' ');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const variantIds = useMemo(() => Object.keys(config.variants), [variantKey]);
  const { variantId, isOverride, settled } = useAssignment(id, variantIds);
  const variant = variantId ?? variantIds[0] ?? '';
  const value = config.variants[variant] as T;

  const [node, setNode] = useState<HTMLElement | null>(null);
  const nodeRef = useRef<HTMLElement | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    nodeRef.current = el;
    setNode(el);
  }, []);

  const goalKey = typeof config.goal === 'string' ? config.goal : JSON.stringify(config.goal);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const goal = useMemo(() => normalizeGoal(config.goal), [goalKey]);
  const goalLabel = goalLabelOf(config.goal);

  useEffect(() => registerComponent({ id, variantIds, goal: goalLabel }), [id, variantIds, goalLabel]);

  // Exposure — same variant_assigned mechanics as <Adaptive>, fired once per
  // (id, variant) once the bind target is in the DOM.
  const exposedRef = useRef<string | null>(null);
  useEffect(() => {
    // Forced variants are a dev/test view — no exposure, no goals, no
    // micro-signals may be recorded (same gate as <Adaptive>).
    if (isOverride) return;
    // Only the SETTLED assignment is a real exposure; the interim variantIds[0]
    // placeholder shown while assign() is in flight must not accrue a phantom
    // baseline impression (same gate as <Adaptive>).
    if (!settled) return;
    if (!client || !variant || !node) return;
    if (exposedRef.current === variant) return;
    exposedRef.current = variant;
    trackExposure(client, apiKey, id, variant);
  }, [client, apiKey, id, variant, node, isOverride, settled]);

  // Goal listeners — identical machinery to <Adaptive> (shared helper).
  const goalFiredRef = useRef(false);
  useEffect(() => {
    goalFiredRef.current = false;
  }, [variant, goalKey]);
  useEffect(() => {
    if (isOverride) return;
    if (!client || !variant || !node) return;
    return attachGoalListeners(node, goal, {
      fireGoal: () => {
        if (goalFiredRef.current) return;
        goalFiredRef.current = true;
        client.track({
          projectId: apiKey,
          componentId: id,
          variantId: variant,
          eventType: 'goal_achieved',
          goalType: goalLabel,
          payload: { reward: 1.0 },
        });
        client.goal(goalLabel, { componentId: id, variantId: variant }, 1.0, 0);
      },
      fireStep: (name, weight, stepIndex) => {
        client.track({
          projectId: apiKey,
          componentId: id,
          variantId: variant,
          eventType: 'goal_achieved',
          goalType: name,
          payload: { reward: weight },
        });
        client.goal(name, {}, weight, stepIndex);
      },
    });
  }, [client, node, variant, apiKey, id, goal, goalLabel, isOverride]);

  // Micro-signal detectors — the third thing <Adaptive>'s container wires.
  useEffect(() => {
    if (isOverride) return;
    if (!client || !variant || !node) return;
    const assignedAt = Date.now();
    return attachMicroSignalDetectors(
      (signalType, extra = {}) => {
        client.track({
          projectId: apiKey,
          componentId: id,
          variantId: variant,
          eventType: 'micro_signal',
          payload: { signalType, ...extra },
        });
      },
      node,
      assignedAt,
    );
  }, [client, node, variant, apiKey, id, isOverride]);

  // Dev warning: bind never attached shortly after mount → exposures would
  // never fire and the slot cannot learn. Once per slot id.
  useEffect(() => {
    if (!isDevBuild()) return;
    if (!client) return;
    const timer = setTimeout(() => {
      if (!nodeRef.current && !warnedUnbound.has(id)) {
        warnedUnbound.add(id);
        console.warn(
          `[sentient] useAdaptive("${id}"): bind was never attached — spread {...bind} on the rendered element, otherwise exposure and goal tracking cannot work and the optimizer learns nothing.`,
        );
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [client, id]);

  const fireGoal = useCallback(
    (goalType?: string, opts?: ComponentGoalOptions) => {
      if (isOverride) return; // forced variants record nothing, even manual goals
      // componentGoal credits the bandit; goal() writes the session goal-funnel
      // record. The declared-goal listener above fires both, so a manual goal
      // for the same slot must too (otherwise it's absent from the funnel).
      // Like useAdaptiveGoal, this writes one funnel record per call with no
      // cross-call latch — keep goal labels unique per conversion (a component
      // that ALSO fires a declared goal on the same action records both).
      const name = goalType ?? goalLabel;
      client?.componentGoal(id, name, opts);
      client?.goal(name, opts?.metadata ?? {}, opts?.reward ?? 1.0, 0);
    },
    [client, id, goalLabel, isOverride],
  );

  const bind = useMemo<UseAdaptiveBind>(
    () => ({ ref, 'data-sentient-id': id, 'data-sentient-variant': variant }),
    [ref, id, variant],
  );

  return { variant, value, bind, fireGoal };
}
