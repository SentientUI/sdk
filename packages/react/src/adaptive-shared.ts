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

export type ScrollDepthGoal = { type: 'scroll_depth'; threshold: number; value?: number };
export type ClickGoal = { type: 'click'; selector?: string; value?: number };
export type FormSubmitGoal = { type: 'form_submit'; value?: number };
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

/** Static revenue value declared on a simple goal config, if any. Composites
 *  carry no value (weights and values don't mix — spec §9.4); dynamic values
 *  go through the imperative hooks. */
export function goalValueOf(goal: string | GoalConfig): number | undefined {
  if (typeof goal === 'string') return undefined;
  if (goal.type === 'click' || goal.type === 'form_submit' || goal.type === 'scroll_depth') {
    return goal.value;
  }
  return undefined;
}

/**
 * Collapses scroll-depth goal fires that belong to one observation moment.
 *
 * Two nested Adaptive components sharing one scroll_depth goal label attach two
 * SEPARATE IntersectionObservers (they observe different container nodes), and
 * one scroll can satisfy both. The platform delivers all IntersectionObserver
 * notifications for that moment within one task, but runs a microtask
 * checkpoint between the two callback invocations ("clean up after running
 * script" fires whenever the JS stack empties — including between separate UA
 * callback invocations in the same task). Core's action latch closes its
 * non-dispatch window on a microtask precisely so a genuine repeat conversion
 * can never be swallowed by a stale window — which means that checkpoint SPLITS
 * the two observer callbacks into two windows, and the goal double-records.
 *
 * So the collapse for this one double-fire lives here, at the layer that knows
 * both fires are scroll-driven, instead of widening core's window for every
 * caller. The scope is one task — the very clock core abandoned — and that is
 * safe HERE for the reason it was wrong there: core's window could be jumped
 * because ANY code (an already-armed timer on the page) can call goal(), so a
 * genuinely separate conversion could land inside a window that outlived its
 * action. Every caller of this gate is an IntersectionObserver callback; timers
 * never consult it, and a genuinely separate scroll fire arrives in a later
 * rendering-update task. Worst case, an implausibly delayed close collapses two
 * same-label, same-value scroll fires — exactly the collapse this gate exists
 * to perform — never a differently-valued or click-driven conversion.
 */
const scrollFiredThisTask = new Set<string>();
let scrollGateClearArmed = false;

export function scrollFireCollapsedThisTask(key: string): boolean {
  if (scrollFiredThisTask.has(key)) return true;
  scrollFiredThisTask.add(key);
  if (!scrollGateClearArmed) {
    scrollGateClearArmed = true;
    const clear = (): void => {
      scrollGateClearArmed = false;
      scrollFiredThisTask.clear();
    };
    // MessageChannel over setTimeout when available: fake-timer test setups
    // freeze setTimeout, which would latch the gate open and swallow every
    // later scroll goal (the same hazard core's old clearNextTask named).
    // Both are macrotasks, so either closes the window after this task.
    if (typeof MessageChannel === 'function') {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        ch.port2.close();
        clear();
      };
      ch.port2.postMessage(0);
    } else {
      setTimeout(clear, 0);
    }
  }
  return false;
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
 *
 * `scrollDedupeKey` is the goal LABEL: nested instances sharing a label and
 * satisfied by one scroll moment are one user action, whatever value each
 * instance declares, so scroll-driven fires collapse per label — see
 * scrollFireCollapsedThisTask. (The inner instance's observer is created first
 * and its callback delivered first, so when an inner valued goal nests in a
 * valueless wrapper, the valued fire is the one that wins the gate.)
 * Click/submit fires never consult it: those share a real event dispatch,
 * which core's action latch already collapses on.
 */
export function attachGoalListeners(
  node: Element,
  goal: GoalConfig,
  handlers: GoalHandlers,
  scrollDedupeKey?: string,
): () => void {
  // --- Weighted composite: each step fires independently as it completes ---
  if (goal.type === 'weighted_composite') {
    const firedSteps = new Set<number>();
    const wcCleanups: Array<() => void> = [];

    goal.steps.forEach(({ goal: sub, name: stepName, weight: stepWeight }, idx) => {
      // viaScroll: a step completed by an IntersectionObserver callback runs the
      // same nested-instance double-fire risk as a plain scroll_depth goal (the
      // microtask checkpoint between two observers' callbacks splits core's
      // window), so it goes through the task gate under its own step identity.
      const fireStep = (viaScroll = false): void => {
        if (firedSteps.has(idx)) return;
        if (
          viaScroll &&
          scrollDedupeKey !== undefined &&
          scrollFireCollapsedThisTask(`step\0${stepName}\0${stepWeight}\0${idx}`)
        ) {
          return;
        }
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
                fireStep(true);
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
  // The scroll gate is consulted only at the moment a goal actually FIRES from
  // a scroll callback — never when a scroll merely completes one subgoal of a
  // still-open composite. Consulting it early would claim the key for an
  // instance that fires nothing, suppressing the nested instance that would
  // have fired, and the conversion would be lost outright.
  const fireViaScroll = (): void => {
    if (scrollDedupeKey !== undefined && scrollFireCollapsedThisTask(scrollDedupeKey)) return;
    handlers.fireGoal();
  };
  const checkComposite = (idx: number, viaScroll = false): void => {
    remaining.delete(idx);
    if (remaining.size !== 0) return;
    if (viaScroll) fireViaScroll();
    else handlers.fireGoal();
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
              if (goal.type === 'composite') checkComposite(idx, true);
              else fireViaScroll();
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
 * Funnel declaration (spec §7.4): one steps-declaration per funnel per page
 * load; membership is per component and idempotent server-side, so re-sends
 * are harmless but avoided. Only a weighted_composite carries steps — a plain
 * goal declares membership only (the funnel must exist server-side already).
 */
const declaredFunnels = new Set<string>();
const declaredMemberships = new Set<string>();

/** Test-only: clears the page-load dedup sets. */
export function __resetFunnelDeclarations(): void {
  declaredFunnels.clear();
  declaredMemberships.clear();
}

export function maybeDeclareFunnel(
  client: SentientClient,
  apiKey: string,
  componentId: string,
  funnelId: string,
  goal: GoalConfig,
): void {
  const memberKey = `${funnelId}|${componentId}`;
  if (declaredMemberships.has(memberKey)) return;
  declaredMemberships.add(memberKey);
  const withSteps = goal.type === 'weighted_composite' && !declaredFunnels.has(funnelId);
  if (withSteps) declaredFunnels.add(funnelId);
  client.track({
    projectId: apiKey,
    componentId,
    eventType: 'funnel_declared',
    payload: withSteps
      ? {
          funnelId,
          steps: (goal as WeightedCompositeGoal).steps.map((s) => ({ goalId: s.name, weight: s.weight })),
        }
      : { funnelId },
  });
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
