import { useCallback } from 'react';
import type { ComponentGoalOptions } from '@sentientui/core';
import { useSentient } from './provider.js';
import { getDevOverride } from './dev-override.js';

export type FireGoal = (goalType: string, opts?: ComponentGoalOptions) => void;

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
  return useCallback<FireGoal>(
    (goalType, opts) => {
      // A forced variant (?sentient_variant= / window.__sentient_overrides) is a
      // dev/QA preview, not real traffic. Recording a goal would credit the
      // bandit and pollute the session funnel for the overridden arm — breaking
      // the "no events recorded, weights unchanged" override contract that
      // <Adaptive>, useAdaptive.fireGoal, and the declarative path all honor.
      // Read post-mount (inside the callback), never in a render body.
      if (getDevOverride(componentId)) return;
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
