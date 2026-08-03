import type { SentientClient } from '@sentientui/core';

declare const process: { env?: { NODE_ENV?: string } } | undefined;

/**
 * True unless NODE_ENV is 'production'. Never `process?.env` — optional
 * chaining still throws ReferenceError on an undeclared global, and browsers
 * without a bundler shim (raw esbuild, vanilla script tags) have no `process`.
 */
export function isDevBuild(): boolean {
  return typeof process === 'undefined' || process.env?.NODE_ENV !== 'production';
}

export type ScrollDepthGoal = { type: 'scroll_depth'; threshold: number };
export type ClickGoal = { type: 'click'; selector?: string };
export type FormSubmitGoal = { type: 'form_submit' };
export type CompositeGoal = { type: 'composite'; all: GoalConfig[] };
export type WeightedStep = { goal: GoalConfig; name: string; weight: number };
export type WeightedCompositeGoal = { type: 'weighted_composite'; steps: WeightedStep[] };
export type GoalConfig = ScrollDepthGoal | ClickGoal | FormSubmitGoal | CompositeGoal | WeightedCompositeGoal;

export function normalizeGoal(goal: string | GoalConfig): GoalConfig {
  if (typeof goal === 'string') return { type: 'click' };
  return goal;
}

/** The goalType label events are recorded under (named goal or config type). */
export function goalLabelOf(goal: string | GoalConfig): string {
  return typeof goal === 'string' ? goal : goal.type;
}

function isClickableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a' || tag === 'button') return true;
  const role = el.getAttribute('role');
  return role === 'button';
}

function findClickable(start: Element, container: Element, selector?: string): boolean {
  if (selector) {
    try {
      let cursor: Element | null = start;
      while (cursor && cursor !== container) {
        if (cursor.matches(selector)) return true;
        cursor = cursor.parentElement;
      }
    } catch {
      // Invalid CSS selector — treat as no match rather than breaking all click handlers.
    }
    return false;
  }
  let cursor: Element | null = start;
  while (cursor && cursor !== container) {
    if (isClickableTarget(cursor)) return true;
    cursor = cursor.parentElement;
  }
  return false;
}

export type GoalHandlers = {
  /** Primary goal completion. Latch-once semantics are the CALLER's job. */
  fireGoal: () => void;
  /** Weighted-composite step completion (already deduped per step here). */
  fireStep: (name: string, weight: number, stepIndex: number) => void;
};

/**
 * Attaches the goal-detection listeners `<Adaptive>`'s container uses —
 * click / form_submit / scroll_depth, composite (all-of), and
 * weighted_composite (independent steps). Returns the cleanup function.
 * Extracted from adaptive.tsx so useAdaptive / useAdaptiveTokens /
 * AdaptiveGroup wire the SAME machinery instead of duplicating it.
 */
export function attachGoalListeners(node: Element, goal: GoalConfig, handlers: GoalHandlers): () => void {
  // --- Weighted composite: each step fires independently as it completes ---
  if (goal.type === 'weighted_composite') {
    const firedSteps = new Set<number>();
    const wcCleanups: Array<() => void> = [];

    goal.steps.forEach(({ goal: sub, name: stepName, weight: stepWeight }, idx) => {
      const fireStep = (): void => {
        if (firedSteps.has(idx)) return;
        firedSteps.add(idx);
        handlers.fireStep(stepName, stepWeight, idx);
      };

      if (sub.type === 'click') {
        const onClick = (e: Event): void => {
          const target = e.target;
          if (!(target instanceof Element)) return;
          if (!findClickable(target, node, sub.selector)) return;
          fireStep();
        };
        node.addEventListener('click', onClick);
        wcCleanups.push(() => node.removeEventListener('click', onClick));
        return;
      }

      if (sub.type === 'form_submit') {
        const onSubmit = (e: Event): void => {
          if (!(e.target instanceof HTMLFormElement)) return;
          if (!node.contains(e.target)) return;
          fireStep();
        };
        node.addEventListener('submit', onSubmit);
        wcCleanups.push(() => node.removeEventListener('submit', onSubmit));
        return;
      }

      if (sub.type === 'scroll_depth') {
        const threshold = Math.max(0, Math.min(1, sub.threshold));
        const io = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.intersectionRatio >= threshold) {
                fireStep();
                io.disconnect();
                break;
              }
            }
          },
          { threshold: [threshold] },
        );
        io.observe(node);
        wcCleanups.push(() => io.disconnect());
      }
    });

    return () => {
      for (const c of wcCleanups) c();
    };
  }
  // --- End weighted composite ---

  const subgoals: GoalConfig[] = goal.type === 'composite' ? goal.all : [goal];
  const remaining = new Set<number>(subgoals.map((_, i) => i));
  const checkComposite = (idx: number): void => {
    remaining.delete(idx);
    if (remaining.size === 0) handlers.fireGoal();
  };

  const cleanups: Array<() => void> = [];

  subgoals.forEach((sub, idx) => {
    if (sub.type === 'click') {
      const onClick = (e: Event): void => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        if (!findClickable(target, node, sub.selector)) return;
        if (goal.type === 'composite') checkComposite(idx);
        else handlers.fireGoal();
      };
      node.addEventListener('click', onClick);
      cleanups.push(() => node.removeEventListener('click', onClick));
      return;
    }

    if (sub.type === 'form_submit') {
      const onSubmit = (e: Event): void => {
        if (!(e.target instanceof HTMLFormElement)) return;
        if (!node.contains(e.target)) return;
        if (goal.type === 'composite') checkComposite(idx);
        else handlers.fireGoal();
      };
      node.addEventListener('submit', onSubmit);
      cleanups.push(() => node.removeEventListener('submit', onSubmit));
      return;
    }

    if (sub.type === 'scroll_depth') {
      const threshold = Math.max(0, Math.min(1, sub.threshold));
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.intersectionRatio >= threshold) {
              if (goal.type === 'composite') checkComposite(idx);
              else handlers.fireGoal();
              io.disconnect();
              break;
            }
          }
        },
        { threshold: [threshold] },
      );
      io.observe(node);
      cleanups.push(() => io.disconnect());
      return;
    }
  });

  return () => {
    for (const c of cleanups) c();
  };
}

/**
 * Records the `variant_assigned` exposure event.
 */
export function trackExposure(
  client: SentientClient,
  apiKey: string,
  componentId: string,
  variantId: string,
): void {
  client.track({
    projectId: apiKey,
    componentId,
    variantId,
    eventType: 'variant_assigned',
    payload: {},
  });
}
