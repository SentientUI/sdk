import { Children, isValidElement, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { SlotDeclInput } from '@sentientui/core';
import { useAdaptiveApiKey, useSentient } from './provider.js';
import { useSlotResult } from './use-slot-result.js';
import { registerSlot } from './devtools-registry.js';
import {
  attachGoalListeners,
  goalLabelOf,
  goalValueOf,
  isDevBuild,
  maybeDeclareFunnel,
  normalizeGoal,
  trackExposure,
  type GoalConfig,
} from './adaptive-shared.js';

export type AdaptiveGroupProps = {
  id: string;
  /** Arrangement id → ordered child keys. FIRST key = baseline default. */
  arrangements: Record<string, string[]>;
  /** Explicit baseline arrangement id (defaults to the first declared). */
  baseline?: string;
  /** Optional slot-scoped goal — credited via componentGoal(group id). */
  goal?: string | GoalConfig;
  /** Funnel this group serves (stable funnel id, e.g. "checkout") — same
   *  declaration semantics as <Adaptive funnel="...">. */
  funnel?: string;
  /** Keyed children — every key referenced by an arrangement must exist. */
  children: ReactNode;
};

// Warn once per group id per page lifetime.
const warnedGroups = new Set<string>();

/**
 * Rung 3 — bounded mini-layout. Reorders KEYED children into the decided
 * arrangement (enumerated-arms slot: arms = Object.keys(arrangements)).
 * Declared orders only — never free permutation, never show/hide.
 * Fail-safe: unknown arrangement or key mismatch renders declaration order.
 */
export function AdaptiveGroup(props: AdaptiveGroupProps): JSX.Element {
  const client = useSentient();
  const apiKey = useAdaptiveApiKey();
  const containerRef = useRef<HTMLDivElement>(null);

  // Freeze the arrangement-id array on the KEY SET (same convention as
  // <Adaptive> / useAdaptive / useAdaptiveTokens): stable across renders for the
  // same keys yet updates if the declared set changes. Declared space is
  // normally fixed per group id for a session.
  const arrangementKey = Object.keys(props.arrangements).join(' ');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const arrangementIds = useMemo(() => Object.keys(props.arrangements), [arrangementKey]);
  const decl = useMemo<SlotDeclInput>(
    () => ({
      id: props.id,
      arms: arrangementIds,
      ...(props.baseline !== undefined ? { baseline: props.baseline } : {}),
    }),
    [props.id, arrangementIds, props.baseline],
  );
  const { arm, source } = useSlotResult(props.id, decl);

  if (
    isDevBuild() &&
    props.baseline !== undefined &&
    props.baseline !== arrangementIds[0] &&
    !warnedGroups.has(props.id + ':baseline')
  ) {
    warnedGroups.add(props.id + ':baseline');
    console.warn(
      `[sentient] <AdaptiveGroup id="${props.id}">: baseline "${props.baseline}" is not the first-declared arrangement ("${arrangementIds[0]}"). The first arrangement should usually be the page's real incumbent (the holdout sees it).`,
    );
  }

  const childArray = Children.toArray(props.children).filter(isValidElement);
  const byKey = new Map<string, (typeof childArray)[number]>();
  for (const child of childArray) {
    // Children.toArray prefixes explicit keys with '.$'.
    byKey.set(String(child.key ?? '').replace(/^\.\$/, ''), child);
  }

  const order = props.arrangements[arm];
  const canReorder =
    order !== undefined &&
    order.length === childArray.length &&
    order.every((key) => byKey.has(key));

  if (
    isDevBuild() &&
    order !== undefined &&
    !canReorder &&
    !warnedGroups.has(props.id + ':keys')
  ) {
    warnedGroups.add(props.id + ':keys');
    console.warn(
      `[sentient] <AdaptiveGroup id="${props.id}">: arrangement "${arm}" [${order.join(', ')}] does not match the children's keys — rendering declaration order (fail-safe).`,
    );
  }

  const ordered = canReorder ? order.map((key) => byKey.get(key)!) : childArray;

  // Devtools slot registry — the declared arms space drives persona simulation
  // and the panel's per-arm override buttons. A group is a slot, not a component:
  // registering it as one produced buttons that wrote the wrong override channel.
  useEffect(
    () => registerSlot({ id: props.id, arms: Object.keys(props.arrangements) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.id],
  );

  // Exposure — once per (group, arrangement). An unresolved `baseline` source
  // means the group was never decided (interim local decide, or a keyed client
  // with no SSR preload); exposing it would record a phantom baseline
  // impression that can never convert, so skip until a real arm resolves.
  const exposedArmRef = useRef<string | null>(null);
  useEffect(() => {
    // A forced arm (`override`, from devtools/tests) is a preview, not a real
    // exposure — skip it so the optimizer isn't trained on the override (same
    // contract <Adaptive> honors for component overrides).
    if (!client || source === 'baseline' || source === 'override' || exposedArmRef.current === arm) return;
    exposedArmRef.current = arm;
    trackExposure(client, apiKey, props.id, arm);
  }, [client, apiKey, props.id, arm, source]);

  // Funnel membership declaration — same override gate as the exposure.
  const funnel = props.funnel;
  useEffect(() => {
    if (!client || !funnel || source === 'override') return;
    maybeDeclareFunnel(client, apiKey, props.id, funnel, normalizeGoal(props.goal ?? 'click'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, apiKey, props.id, funnel, source]);

  // Optional goal — slot-scoped credit through componentGoal (the core
  // resolves the attributed arm from its slot state; see Task 3.3).
  const goalKey =
    props.goal === undefined ? null : typeof props.goal === 'string' ? props.goal : JSON.stringify(props.goal);
  useEffect(() => {
    // Forced arms record nothing (preview only) — same gate as the exposure.
    if (!client || props.goal === undefined || source === 'override') return;
    const node = containerRef.current;
    if (!node) return;
    const label = goalLabelOf(props.goal);
    const declaredValue = goalValueOf(props.goal);
    let fired = false;
    return attachGoalListeners(node, normalizeGoal(props.goal), {
      fireGoal: () => {
        if (fired) return;
        fired = true;
        // componentGoal credits the bandit; goal() writes the session-level
        // conversion funnel record — matching <Adaptive>. Firing only the
        // former left group conversions out of the goal funnel. A static
        // goal-config value rides on both writes (spec §5).
        if (declaredValue !== undefined) client.componentGoal(props.id, label, { value: declaredValue });
        else client.componentGoal(props.id, label);
        client.goal(label, {
          metadata: { componentId: props.id, arm },
          weight: 1.0,
          stepIndex: 0,
          ...(declaredValue !== undefined ? { value: declaredValue } : {}),
        });
      },
      fireStep: (name, weight, stepIndex) => {
        client.componentGoal(props.id, name, { reward: weight });
        client.goal(name, { metadata: { componentId: props.id, arm }, weight, stepIndex });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, props.id, goalKey, arm, source]);

  return (
    <div ref={containerRef} data-sentient-id={props.id} data-sentient-variant={arm}>
      {ordered}
    </div>
  );
}
