import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { attachMicroSignalDetectors, type MicroSignalType, type SentientClient } from '@sentientui/core';
import { useAdaptiveApiKey, useSentient } from './provider.js';
import { useAssignment } from './use-assignment.js';
import { registerComponent } from './devtools-registry.js';
import {
  attachGoalListeners,
  goalLabelOf,
  goalValueOf,
  maybeDeclareFunnel,
  normalizeGoal,
  trackExposure,
  type GoalConfig,
} from './adaptive-shared.js';

/** Maps a detected micro-signal to a named session goal (`client.goal`). */
export type MicroSignalGoalConfig = string | { name: string; weight?: number; stepIndex?: number };
export type MicroSignalGoals = Partial<Record<MicroSignalType, MicroSignalGoalConfig>>;

export type VariantComponentOptions = {
  goal: string | GoalConfig | undefined;
  funnel?: string;
  microSignalGoals?: MicroSignalGoals;
  agentData?: unknown;
  agentDataByVariant?: Record<string, unknown>;
  /** Emit `cursor_signal` after 800 ms of continuous hover (<Adaptive> only). */
  cursorSignal?: boolean;
};

export type VariantComponentState = {
  client: SentientClient | null;
  variantIds: string[];
  /** Null until useAssignment has any variant (e.g. SSR with ssrFallback 'none'). */
  variantId: string | null;
  content: string | null;
  settled: boolean;
  isOverride: boolean;
  goalLabel: string;
  /** Callback ref — attach to the element exposure/goals/micro-signals bind to. */
  ref: (el: HTMLElement | null) => void;
  nodeRef: RefObject<HTMLElement | null>;
};

/**
 * The measurement engine shared by `<Adaptive variants>` and `useAdaptive`:
 * assignment, devtools registration, exposure, funnel declaration, goal
 * listeners and micro-signal detectors.
 *
 * It exists because the two used to carry copies of these effects and drifted:
 * the hook's micro-signal effect lost the `settled` gate <Adaptive> had, so a
 * rage-click during the interim-baseline window recorded a micro_signal on an
 * arm that was never served, and the hook silently had no `microSignalGoals`.
 * Every gate below now applies to both callers at once.
 */
export function useVariantComponent(
  id: string,
  variants: Record<string, unknown>,
  opts: VariantComponentOptions,
): VariantComponentState {
  const client = useSentient();
  const apiKey = useAdaptiveApiKey();
  // Freeze the variant-id array on the KEY SET, not the object identity: an
  // inline `variants={{...}}` literal is a fresh object every render, so keying
  // on the object churned a new array each commit — re-running the register
  // effect and unregistering+re-registering the component on every render.
  // Same convention as AdaptiveGroup / useAdaptiveTokens.
  const variantKey = Object.keys(variants).join('\u0000');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const variantIds = useMemo(() => Object.keys(variants), [variantKey]);
  const { variantId, content, isOverride = false, settled } = useAssignment(
    id,
    variantIds,
    opts.agentData,
    opts.agentDataByVariant,
  );

  // Callback ref + state, not a plain useRef: useAdaptive's bind target is the
  // caller's element and may attach after (or be swapped out from under) the
  // first commit — a useRef read inside effects never re-runs them, so
  // listeners stayed on a detached node or never attached.
  const [node, setNode] = useState<HTMLElement | null>(null);
  const nodeRef = useRef<HTMLElement | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    nodeRef.current = el;
    setNode(el);
  }, []);

  const rawGoal = opts.goal;
  const goalKey = typeof rawGoal === 'string' ? rawGoal : JSON.stringify(rawGoal);
  // Missing-goal misuse fails SOFT (callers may throw in dev first): an
  // unconditional goalLabelOf(undefined) crashed the whole prod render on
  // `undefined.type`. Serve and expose the variant, wire no goal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const goal = useMemo(() => (rawGoal ? normalizeGoal(rawGoal) : null), [goalKey]);
  const goalLabel = rawGoal ? goalLabelOf(rawGoal) : '';

  // Register with the devtools registry so the dev widget can list this
  // component + its variants. Inert in production; cleanup unregisters.
  useEffect(() => registerComponent({ id, variantIds, goal: goalLabel }), [id, variantIds, goalLabel]);

  // Exposure: variant_assigned exactly once per (component, variant) mount.
  const exposedRef = useRef<string | null>(null);
  useEffect(() => {
    // A forced variant is a dev/test view, not a real exposure — recording it
    // would train the bandit on the override. Same gate on every tracking
    // effect below ("no events recorded, weights unchanged").
    if (isOverride) return;
    // Only expose a SETTLED assignment. On the CSR path the served variant
    // resolves in two steps (interim baseline variantIds[0] → bandit choice);
    // tracking the interim would accrue a phantom baseline exposure that can
    // never convert.
    if (!settled) return;
    if (!client || !variantId || !apiKey || !node) return;
    if (exposedRef.current === variantId) return;
    exposedRef.current = variantId;
    trackExposure(client, apiKey, id, variantId);
  }, [client, variantId, apiKey, id, node, isOverride, settled]);

  // Goal latches reset when the variant or goal changes.
  const goalFiredRef = useRef(false);
  const microGoalFiredRef = useRef<Set<MicroSignalType>>(new Set());
  useEffect(() => {
    goalFiredRef.current = false;
    microGoalFiredRef.current = new Set();
  }, [variantId, goal]);

  // Declare funnel membership (and, for weighted composites, the funnel's
  // steps) once per page load. Same settle/override gates as the exposure —
  // a forced dev view must not declare anything.
  const funnel = opts.funnel;
  useEffect(() => {
    if (isOverride || !settled) return;
    if (!client || !funnel || !goal) return;
    maybeDeclareFunnel(client, apiKey, id, funnel, goal);
  }, [client, apiKey, id, funnel, goal, isOverride, settled]);

  // cursor_signal after 800 ms of continuous hover.
  const cursorSignal = opts.cursorSignal === true;
  useEffect(() => {
    if (!cursorSignal || isOverride) return;
    // Same settle gate as the exposure: before assign() resolves, variantId is
    // the interim baseline placeholder — a hover then would attribute a
    // cursor_signal to an arm that was never really served.
    if (!settled) return;
    if (!client || !variantId || !node) return;

    let timerId: ReturnType<typeof setTimeout> | null = null;
    let hoverStart = 0;
    const onEnter = (): void => {
      hoverStart = Date.now();
      timerId = setTimeout(() => {
        client.track({
          projectId: apiKey,
          componentId: id,
          variantId,
          eventType: 'cursor_signal',
          payload: { hoverDuration: Date.now() - hoverStart },
        });
        timerId = null;
      }, 800);
    };
    const onLeave = (): void => {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
    };
    node.addEventListener('mouseenter', onEnter);
    node.addEventListener('mouseleave', onLeave);
    return () => {
      node.removeEventListener('mouseenter', onEnter);
      node.removeEventListener('mouseleave', onLeave);
      if (timerId !== null) clearTimeout(timerId);
    };
  }, [cursorSignal, client, variantId, apiKey, id, node, isOverride, settled]);

  // Micro-signal detectors — rage click, text copy, scroll hesitation, tab loss.
  // The mapping is read through a ref and the effect is keyed on its CONTENT:
  // attachMicroSignalDetectors latches each signal once per attach, so keying
  // on identity re-attached on every render for an inline `microSignalGoals`
  // literal (the natural way to call useAdaptive), resetting those latches and
  // re-emitting the same micro_signal repeatedly.
  const microSignalGoalsRef = useRef(opts.microSignalGoals);
  microSignalGoalsRef.current = opts.microSignalGoals;
  const microKey = opts.microSignalGoals ? JSON.stringify(opts.microSignalGoals) : '';
  useEffect(() => {
    if (isOverride) return;
    // Gate on settle too (like the exposure): during the pre-assign() window
    // variantId is the interim baseline placeholder, so a rage-click / tab-loss
    // would record a micro_signal — and fire a mapped named goal — attributed
    // to an arm that was never really served. useAdaptive lacked this gate
    // before the two paths shared this hook.
    if (!settled) return;
    if (!client || !variantId || !node) return;
    const assignedAt = Date.now();
    return attachMicroSignalDetectors(
      (signalType, extra = {}) => {
        client.track({
          projectId: apiKey,
          componentId: id,
          variantId,
          eventType: 'micro_signal',
          payload: { signalType, ...extra },
        });

        const mapping = microSignalGoalsRef.current?.[signalType];
        if (!mapping || microGoalFiredRef.current.has(signalType)) return;
        microGoalFiredRef.current.add(signalType);
        const name = typeof mapping === 'string' ? mapping : mapping.name;
        const weight = typeof mapping === 'string' ? 1.0 : (mapping.weight ?? 1.0);
        const stepIndex = typeof mapping === 'string' ? 0 : (mapping.stepIndex ?? 0);
        // Explicit options form: `extra` is arbitrary micro-signal data, so it
        // must land in metadata and never be mistaken for GoalOptions keys.
        client.goal(name, { metadata: { signalType, ...extra }, weight, stepIndex });
      },
      node,
      assignedAt,
    );
  }, [client, variantId, apiKey, id, node, microKey, isOverride, settled]);

  // Goal listeners (shared machinery — see adaptive-shared.ts).
  useEffect(() => {
    if (isOverride) return;
    // Same settle gate as the exposure: before assign() resolves, variantId is
    // the interim baseline placeholder, which never recorded an impression — a
    // conversion in that window would attribute to an arm with zero exposures
    // and corrupt its stats.
    if (!settled) return;
    if (!client || !variantId || !node || !goal) return;

    // A static `value` on the goal config rides on BOTH writes (the component-
    // attributed event and the session funnel record) so read-time dedup never
    // picks a valueless row. Steps carry weights, never values (spec §9.4).
    const declaredValue = goalValueOf(goal);
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
          payload: { reward: 1.0, ...(declaredValue !== undefined ? { goalValue: declaredValue } : {}) },
        });
        client.goal(goalLabel, {
          metadata: { componentId: id, variantId },
          weight: 1.0,
          stepIndex: 0,
          ...(declaredValue !== undefined ? { value: declaredValue } : {}),
        });
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
        client.goal(name, { metadata: {}, weight, stepIndex });
      },
    }, goalLabel);
  }, [client, variantId, apiKey, id, node, goal, goalLabel, isOverride, settled]);

  return { client, variantIds, variantId, content, settled, isOverride, goalLabel, ref, nodeRef };
}
