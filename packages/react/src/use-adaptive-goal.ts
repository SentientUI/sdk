import { useCallback, useRef } from 'react';
import type { ComponentGoalOptions } from '@sentientui/core';
import { useSentient } from './provider.js';
import { getDevOverride } from './dev-override.js';

export interface FireGoalOptions extends ComponentGoalOptions {
  /**
   * Record this goal at most once per mounted component, however many times the
   * callback is invoked. Use it for conversions that are a state, not an action
   * — "reached step 3", "form validated", an effect that may re-run — where a
   * second record is double counting rather than a second conversion.
   *
   * Leave it off for genuine repeat actions (each click of "add to cart" is its
   * own conversion). The latch is per goal type and lives for the lifetime of
   * the component holding the callback, so a remount can record again.
   */
  once?: boolean;
}

export type FireGoal = (goalType: string, opts?: FireGoalOptions) => void;

/**
 * Returns a `fireGoal(goalType, opts?)` callback that records a conversion
 * attributed to the variant currently served for `componentId` — so it shows
 * up in the per-variant CVR funnel with no manual variantId/projectId plumbing.
 *
 * The served variant is resolved from the SDK's assignment cache (the same one
 * `<Adaptive id={componentId}>` populates), so render that component before
 * firing. Use this for imperative handlers (click, form submit, custom events);
 * for purely declarative goals prefer `<Adaptive goal={...}>`.
 *
 * Each call records one bandit reward event AND one session goal-funnel record.
 * It has no cross-call latch, so a component that *also* declares a matching
 * `<Adaptive goal>` (or fires this on every click) records one conversion per
 * call — keep goal labels unique per conversion so counts aren't inflated.
 *
 * @example
 * const fireContact = useAdaptiveGoal('hero_headline');
 * <button onClick={() => fireContact('hero_contact', { metadata: { method } })}>Call</button>
 */
export function useAdaptiveGoal(componentId: string): FireGoal {
  const client = useSentient();
  // Goal types already recorded through this callback, for `once`. A ref, not
  // state: latching must not re-render, and the set has to survive the callback
  // being recreated when the client arrives (consent granted mid-session).
  const firedOnce = useRef<Set<string>>(new Set());
  return useCallback<FireGoal>(
    (goalType, opts) => {
      // A forced variant (?sentient_variant= / window.__sentient_overrides) is a
      // dev/QA preview, not real traffic. Recording a goal would credit the
      // bandit and pollute the session funnel for the overridden arm — breaking
      // the "no events recorded, weights unchanged" override contract that
      // <Adaptive>, useAdaptive.fireGoal, and the declarative path all honor.
      // Read post-mount (inside the callback), never in a render body.
      // Checked BEFORE the `once` latch: a preview must not consume the one
      // record a real conversion is entitled to after the override clears.
      if (getDevOverride(componentId)) return;
      if (opts?.once) {
        if (firedOnce.current.has(goalType)) return;
        firedOnce.current.add(goalType);
      }
      // componentGoal credits the bandit (arm resolved from the assignment
      // cache); goal() writes the session-level conversion funnel record. A
      // declared <Adaptive goal> fires both — a manual conversion for the same
      // component must too, or it shows up in per-variant CVR but never in the
      // session goal funnel.
      client?.componentGoal(componentId, goalType, opts);
      client?.goal(goalType, opts?.metadata ?? {}, opts?.reward ?? 1.0, 0);
    },
    [client, componentId],
  );
}
