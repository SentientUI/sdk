import type { GoalName } from './goal-names.js';
import { useCallback, useEffect, useRef } from 'react';
import type { SentientClient } from '@sentientui/core';
import { useAdaptiveApiKey, useSentient } from './provider.js';
import { goalOptionsOf, useAdaptiveGoal, type FireGoalOptions } from './use-adaptive-goal.js';
import { isDevBuild } from './adaptive-shared.js';

export interface UseGoalOptions {
  /**
   * Make this the project's main goal — the one experiments optimize and
   * results are measured on. Change which hook carries it and deploy to change
   * the main goal; no dashboard visit needed.
   *
   * It moves the main goal only when the declared goal CHANGES, so a main goal
   * picked in the dashboard sticks until your code declares a different one.
   * From localhost it only sets a main goal when the project has none. Every
   * change is in the project's activity log. Declare it in ONE place: two
   * different `primary` goals on a page are a mistake, and only the first counts.
   */
  primary?: boolean;
  /**
   * Also credit the conversion to the version currently served for this
   * component (same as `useAdaptiveGoal(componentId)`). Omit for a goal that
   * belongs to the visit, not to one component.
   */
  componentId?: string;
}

/** Records the goal. Options are per conversion: a value, an order id, `once`. */
export type FireNamedGoal = (opts?: FireGoalOptions) => void;

// What this page load has already declared, per API key. A declaration is a
// definition, not telemetry: once per page is all the server needs (it keeps
// the steady state at zero writes itself), and every mount of a component
// holding the hook re-running it would be one event per render tree.
const declared = new Set<string>();
const primaryByKey = new Map<string, string>();

/** Test-only: clears the page-load declaration state. */
export function __resetGoalDeclarations(): void {
  declared.clear();
  primaryByKey.clear();
}

function declareGoal(client: SentientClient, apiKey: string, name: string, primary: boolean): void {
  let asPrimary = primary;
  if (primary) {
    const existing = primaryByKey.get(apiKey);
    if (existing && existing !== name) {
      // Two main goals on one page: whichever mounts first would win per page,
      // and the server would see them alternate. Keep the first and say so,
      // rather than let the main goal depend on render order.
      if (isDevBuild()) {
        console.warn(`[SentientUI] useGoal('${name}'): '${existing}' is already primary on this page`);
      }
      asPrimary = false;
    } else {
      primaryByKey.set(apiKey, name);
    }
  }
  const key = `${apiKey}|${name}|${asPrimary ? 'primary' : ''}`;
  if (declared.has(key)) return;
  declared.add(key);
  client.track({
    projectId: apiKey,
    componentId: '__session__',
    eventType: 'goal_declared',
    payload: asPrimary ? { goalId: name, primary: true } : { goalId: name },
  });
}

/**
 * A goal your site records — declared where it happens, and fired from there.
 *
 * Declaring it is what makes it show in the dashboard straight away, at an
 * honest 0, before anyone has completed it. `primary: true` makes it the
 * project's main goal. The returned function records one conversion.
 *
 * @example
 * const signup = useGoal('signup', { primary: true });
 * <form onSubmit={() => signup()}>…</form>
 *
 * @example
 * // A revenue goal, credited to the hero version that was showing.
 * const purchase = useGoal('purchase', { componentId: 'hero_cta' });
 * purchase({ value: order.total, externalId: order.id });
 */
export function useGoal(name: GoalName, options: UseGoalOptions = {}): FireNamedGoal {
  const { primary = false, componentId } = options;
  const client = useSentient();
  const apiKey = useAdaptiveApiKey();
  // Called unconditionally (rules of hooks); used only with componentId. It
  // carries the dev-override contract — a forced version records nothing.
  const fireComponentGoal = useAdaptiveGoal(componentId ?? '');
  const firedOnce = useRef(false);

  useEffect(() => {
    // Not into a consent-gated client: React swaps in a tracking client on
    // grant, the effect re-runs with it, and the declaration goes out then.
    if (!client || client.gated || !apiKey) return;
    declareGoal(client, apiKey, name, primary);
  }, [client, apiKey, name, primary]);

  return useCallback<FireNamedGoal>(
    (opts) => {
      if (opts?.once) {
        if (firedOnce.current) return;
        firedOnce.current = true;
      }
      if (componentId) {
        fireComponentGoal(name, opts);
        return;
      }
      client?.goal(name, goalOptionsOf(opts));
    },
    [client, componentId, fireComponentGoal, name],
  );
}
