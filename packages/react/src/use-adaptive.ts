import { useCallback, useEffect, useMemo } from 'react';
import type { ComponentGoalOptions } from '@sentientui/core';
import { isDevBuild, type GoalConfig } from './adaptive-shared.js';
import { useVariantComponent, type MicroSignalGoals } from './use-variant-component.js';

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
  config: {
    variants: Record<string, T>;
    goal: string | GoalConfig;
    /** Funnel this component serves (stable funnel id, e.g. "checkout") —
     *  same declaration semantics as <Adaptive funnel="...">. */
    funnel?: string;
    /** When a passive micro-signal fires on the bound element, also record a
     *  named goal — same mapping as <Adaptive microSignalGoals>. */
    microSignalGoals?: MicroSignalGoals;
  },
): UseAdaptiveResult<T> {
  if (isDevBuild() && !config.goal) {
    throw new Error(
      `[sentient] useAdaptive("${id}"): a goal is required — without one the optimizer accumulates exposures with no rewards and cannot learn. Pass e.g. goal: 'buy_click'.`,
    );
  }

  // Selection + exposure/funnel/goal/micro-signal wiring is the engine shared
  // with <Adaptive variants>. No cursor_signal here: the hook never sent one and
  // adding an event stream is not a refactor.
  const { client, variantIds, variantId, isOverride, goalLabel, ref, nodeRef } = useVariantComponent(
    id,
    config.variants,
    { goal: config.goal, funnel: config.funnel, microSignalGoals: config.microSignalGoals },
  );
  // Unlike <Adaptive> (which renders nothing without a variant), the headless
  // hook always hands back a value: the first key until a variant resolves.
  const variant = variantId ?? variantIds[0] ?? '';
  const value = config.variants[variant] as T;

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
      // Empty only on the missing-goal misuse path (fail-soft above) with no
      // explicit goalType — nothing meaningful to record.
      if (!name) return;
      client?.componentGoal(id, name, opts);
      client?.goal(name, {
        metadata: opts?.metadata ?? {},
        weight: opts?.reward ?? 1.0,
        stepIndex: 0,
        ...(opts?.value !== undefined ? { value: opts.value } : {}),
        ...(opts?.currency !== undefined ? { currency: opts.currency } : {}),
        ...(opts?.externalId !== undefined ? { externalId: opts.externalId } : {}),
      });
    },
    [client, id, goalLabel, isOverride],
  );

  const bind = useMemo<UseAdaptiveBind>(
    () => ({ ref, 'data-sentient-id': id, 'data-sentient-variant': variant }),
    [ref, id, variant],
  );

  return { variant, value, bind, fireGoal };
}
