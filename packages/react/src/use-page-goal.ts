import { useEffect, useRef } from 'react';
import type { ComponentGoalOptions } from '@sentientui/core';
import { useSentient } from './provider.js';
import { useAdaptiveGoal } from './use-adaptive-goal.js';

export interface PageGoalOptions extends ComponentGoalOptions {
  /**
   * Credit the arrival to the variant currently served for this component —
   * typically the CTA on the page the visitor came FROM. The served variant is
   * read from the assignment cache, which is localStorage-backed, so the credit
   * survives the navigation. Omit for a session-level goal with no per-variant
   * attribution.
   */
  componentId?: string;
}

/**
 * Records `goalName` once, when a page or route is reached.
 *
 * Use this for funnel steps that are a *destination* rather than a click:
 * reaching /pricing, landing on a signup form, opening a checkout. Arrival is
 * the better signal — it survives the navigation that a click goal can lose,
 * and it also counts visitors who arrived from the nav, a search result or a
 * shared link, none of whom clicked the CTA being measured.
 *
 * Two things this handles that hand-rolling `useAdaptiveGoal` in an effect does
 * not, both of which fail silently:
 *
 *  - **Fires once.** `useAdaptiveGoal` has no latch, so a remount — or React's
 *    double-invoked effects in development — records the same arrival twice and
 *    inflates the funnel.
 *  - **Waits for consent.** Under a consent gate the client does not exist when
 *    the page mounts, and a visitor who accepts a moment later would lose the
 *    goal entirely. The arrival is held until the SDK is running, then sent.
 *
 * Safe during SSR (effects do not run on the server) and a no-op without a
 * provider above it.
 *
 * @example
 * // Credit reaching the pricing page to whichever hero CTA sent them.
 * usePageGoal('pricing_view', { componentId: 'hero_cta' });
 *
 * @example
 * // Session-level only — no component to attribute it to.
 * usePageGoal('docs_view');
 */
export function usePageGoal(goalName: string, opts: PageGoalOptions = {}): void {
  const { componentId, ...goalOpts } = opts;
  const client = useSentient();
  // Called unconditionally (rules of hooks); only used when componentId is set.
  // It carries the dev-override contract — a forced variant records nothing —
  // so component-attributed arrivals inherit it for free.
  const fireComponentGoal = useAdaptiveGoal(componentId ?? '');
  const fired = useRef(false);
  // Callers pass an object literal, so `goalOpts` has a new identity every
  // render. Keeping it in a ref keeps it out of the dep array without making
  // the effect re-run (the latch would ignore it anyway).
  const optsRef = useRef(goalOpts);
  optsRef.current = goalOpts;

  useEffect(() => {
    if (!client || fired.current) return;
    fired.current = true;
    const { metadata, reward } = optsRef.current;
    if (componentId) {
      fireComponentGoal(goalName, optsRef.current);
      return;
    }
    client.goal(goalName, metadata ?? {}, reward ?? 1.0, 0);
  }, [client, componentId, goalName, fireComponentGoal]);
}
