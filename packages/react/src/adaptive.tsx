'use client';

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { attachMicroSignalDetectors, type MicroSignalType } from '@sentientui/core';
import { useAdaptiveApiKey, useSentient } from './provider.js';
import { useAssignment } from './use-assignment.js';
import { registerComponent } from './devtools-registry.js';

export type {
  ScrollDepthGoal,
  ClickGoal,
  FormSubmitGoal,
  CompositeGoal,
  WeightedStep,
  WeightedCompositeGoal,
  GoalConfig,
} from './adaptive-shared.js';
import { attachGoalListeners, goalValueOf, isDevBuild, maybeDeclareFunnel, normalizeGoal, trackExposure, type GoalConfig } from './adaptive-shared.js';

/** Maps a detected micro-signal to a named session goal (`client.goal`). */
export type MicroSignalGoalConfig = string | { name: string; weight?: number; stepIndex?: number };
export type MicroSignalGoals = Partial<Record<MicroSignalType, MicroSignalGoalConfig>>;

export type AdaptiveProps = {
  id: string;
  variants: Record<string, ReactNode>;
  goal: string | GoalConfig;
  /**
   * Funnel this component serves (stable funnel id, e.g. "checkout" —
   * shown on the dashboard's Funnels tab). Declares membership to the server;
   * a weighted_composite goal also declares the funnel's ordered steps, so a
   * code-first funnel appears in the dashboard without opening it. The
   * optimizer then trains this component on journey progress: small credit for
   * intermediate steps, full (or revenue-scaled) credit at completion.
   */
  funnel?: string;
  /**
   * When a passive micro-signal fires on this component, also record a named goal.
   * Use for inferred goals surfaced in the dashboard (e.g. rage_click → 'confused_by_hero').
   */
  microSignalGoals?: MicroSignalGoals;
  /**
   * When true, renders nothing during SSR and before client hydration.
   * Use when you cannot pass `initialAssignments` and prefer a blank slot over
   * a hydration mismatch. Tradeoff: minor CLS on first paint.
   */
  clientOnly?: boolean;
  /**
   * Variant-specific structured data for AI agent consumption via /sentient.json and
   * GET /v1/agent/layout. Keyed by variant ID — only the assigned variant's entry is stored,
   * so agents see only the content currently being served to visitors.
   *
   * Prefer this over `agentData` when variants have meaningfully different content.
   *
   * Captured at MOUNT: this value is read once, when the component's assignment
   * is requested, and is intentionally not part of the assign effect's deps.
   * Changing it after mount does not re-send it — pass the final value on first
   * render (e.g. from SSR/loader data, not a value that streams in later).
   */
  agentDataByVariant?: Record<string, unknown>;
  /**
   * @deprecated Use agentDataByVariant for variant-specific content. Stored as-is for the assigned variant.
   *
   * Captured at MOUNT (see `agentDataByVariant`): changing it after mount has no
   * effect on what is sent for the assignment.
   */
  agentData?: unknown;
};

function AdaptiveImpl(props: AdaptiveProps): JSX.Element | null {
  const client = useSentient();
  const apiKey = useAdaptiveApiKey();
  // Freeze the variant-id array on the KEY SET, not the object identity: an
  // inline `variants={{...}}` literal is a fresh object every render, so keying
  // on `props.variants` churned a new array each commit — re-running the
  // register effect (dep below) and unregistering+re-registering the component
  // on every render. A joined-keys signature is stable across renders for the
  // same keys yet still updates if the declared set changes. Same convention as
  // useAdaptive / AdaptiveGroup / useAdaptiveTokens.
  const variantKey = Object.keys(props.variants).join('\u0000');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const variantIds = useMemo(() => Object.keys(props.variants), [variantKey]);
  const { variantId, content, isOverride, settled } = useAssignment(props.id, variantIds, props.agentData, props.agentDataByVariant);
  const containerRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);
  const goalFiredRef = useRef(false);
  const microGoalFiredRef = useRef<Set<MicroSignalType>>(new Set());
  const assignTrackedRef = useRef<string | null>(null);
  const goalKey = typeof props.goal === 'string' ? props.goal : JSON.stringify(props.goal);
  const goal = useMemo(() => normalizeGoal(props.goal), [goalKey]);
  const goalLabel = typeof props.goal === 'string' ? props.goal : goal.type;

  // Register with the devtools registry so the dev widget can list this
  // component + its variants. Inert in production (registry has no UI); the
  // cleanup unregisters on unmount.
  useEffect(() => registerComponent({ id: props.id, variantIds, goal: goalLabel }), [props.id, variantIds, goalLabel]);

  // Track variant_assigned exactly once per (component, variant) mount.
  useEffect(() => {
    // A forced variant is a dev/test view, not a real exposure — recording it
    // would train the bandit on the override. Same gate on every tracking
    // effect below ("no events recorded, weights unchanged").
    if (isOverride) return;
    // Only expose a SETTLED assignment. On the CSR path the served variant
    // resolves in two steps (interim baseline variantIds[0] → bandit choice);
    // tracking the interim would accrue a phantom baseline exposure that can
    // never convert. Mirrors AdaptiveText (start null, track after settle).
    if (!settled) return;
    if (!client || !variantId || !apiKey) return;
    if (assignTrackedRef.current === variantId) return;
    assignTrackedRef.current = variantId;
    trackExposure(client, apiKey, props.id, variantId);
  }, [client, variantId, apiKey, props.id, isOverride, settled]);

  // Reset goal latch when variant or goal changes.
  useEffect(() => {
    goalFiredRef.current = false;
    microGoalFiredRef.current = new Set();
  }, [variantId, goal]);

  // Declare funnel membership (and, for weighted composites, the funnel's
  // steps) once per page load. Same settle/override gates as the exposure —
  // a forced dev view must not declare anything.
  useEffect(() => {
    if (isOverride || !settled) return;
    if (!client || !props.funnel) return;
    maybeDeclareFunnel(client, apiKey, props.id, props.funnel, goal);
  }, [client, apiKey, props.id, props.funnel, goal, isOverride, settled]);

  // Emit cursor_signal after 800 ms of continuous hover.
  useEffect(() => {
    if (isOverride) return;
    // Same settle gate as the exposure: before assign() resolves, variantId is
    // the interim baseline placeholder — a hover then would attribute a
    // cursor_signal to an arm that was never really served.
    if (!settled) return;
    if (!client || !variantId) return;
    const node = containerRef.current;
    if (!node) return;

    let timerId: ReturnType<typeof setTimeout> | null = null;
    let hoverStart = 0;

    const onEnter = (): void => {
      hoverStart = Date.now();
      timerId = setTimeout(() => {
        client.track({
          projectId: apiKey,
          componentId: props.id,
          variantId: variantId!,
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
  }, [client, variantId, apiKey, props.id, isOverride, settled]);

  // Attach micro-signal detectors passively — rage click, text copy, scroll hesitation, tab loss.
  useEffect(() => {
    if (isOverride) return;
    // Gate on settle too (like the exposure): during the pre-assign() window
    // variantId is the interim baseline placeholder, so a rage-click / tab-loss
    // would record a micro_signal — and fire a mapped named goal — attributed
    // to an arm that was never really served.
    if (!settled) return;
    if (!client || !variantId) return;
    const node = containerRef.current;
    if (!node) return;
    const assignedAt = Date.now();
    return attachMicroSignalDetectors(
      (signalType, extra = {}) => {
        client.track({
          projectId: apiKey,
          componentId: props.id,
          variantId: variantId!,
          eventType: 'micro_signal',
          payload: { signalType, ...extra },
        });

        const mapping = props.microSignalGoals?.[signalType];
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
  }, [client, variantId, apiKey, props.id, props.microSignalGoals, isOverride, settled]);

  // Attach goal tracking (shared machinery — see adaptive-shared.ts).
  useEffect(() => {
    if (isOverride) return;
    if (!client || !variantId) return;
    const node = containerRef.current;
    if (!node) return;

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
          componentId: props.id,
          variantId,
          eventType: 'goal_achieved',
          goalType: goalLabel,
          payload: { reward: 1.0, ...(declaredValue !== undefined ? { goalValue: declaredValue } : {}) },
        });
        client.goal(goalLabel, {
          metadata: { componentId: props.id, variantId },
          weight: 1.0,
          stepIndex: 0,
          ...(declaredValue !== undefined ? { value: declaredValue } : {}),
        });
      },
      fireStep: (name, weight, stepIndex) => {
        client.track({
          projectId: apiKey,
          componentId: props.id,
          variantId: variantId!,
          eventType: 'goal_achieved',
          goalType: name,
          payload: { reward: weight },
        });
        client.goal(name, { metadata: {}, weight, stepIndex });
      },
    });
  }, [client, variantId, apiKey, props.id, goal, goalLabel, isOverride]);

  // Decorative slots: empty in SSR HTML and until the client has mounted.
  if (props.clientOnly && (!mounted || !client)) return null;
  if (!variantId) return null;

  const jsxContent = props.variants[variantId] ?? null;
  const managedContent = jsxContent === null ? content : null;

  if (isDevBuild() && jsxContent === null && managedContent === null) {
    console.warn(
      `[sentient] <Adaptive id="${props.id}"> was assigned variant "${variantId}" but no matching key exists in props.variants.` +
      ` If this is a dashboard-managed text variant, use <AdaptiveText id="${props.id}"> instead.`,
    );
  }

  return (
    <div ref={containerRef} data-sentient-id={props.id} data-sentient-variant={variantId}>
      {jsxContent ?? managedContent}
    </div>
  );
}

/**
 * Skips re-render only when nothing the output depends on has changed. The
 * variant node values must be compared, not just their keys: the assigned
 * `variantId` is stable, so if we compared keys alone, dynamic content inside a
 * variant (e.g. `<Price value={price}/>`) would render once and then freeze when
 * `price` changes. Elements are compared by reference — a caller that recreates
 * variant JSX on every render re-renders every time (correct), while stable/
 * memoized elements keep the optimization.
 */
export const Adaptive = memo(AdaptiveImpl, (prev, next) => {
  if (prev.id !== next.id) return false;
  // Serialize only when the goal reference actually changed — a stable/memoized
  // goal (the common case) skips the stringify entirely.
  if (prev.goal !== next.goal && JSON.stringify(prev.goal) !== JSON.stringify(next.goal)) return false;
  if (prev.microSignalGoals !== next.microSignalGoals) return false;
  if (prev.clientOnly !== next.clientOnly) return false;
  if (prev.agentData !== next.agentData) return false;
  if (prev.agentDataByVariant !== next.agentDataByVariant) return false;
  if (prev.variants === next.variants) return true;
  const prevKeys = Object.keys(prev.variants);
  const nextKeys = Object.keys(next.variants);
  if (prevKeys.length !== nextKeys.length) return false;
  return prevKeys.every((k) => k in next.variants && Object.is(prev.variants[k], next.variants[k]));
});
