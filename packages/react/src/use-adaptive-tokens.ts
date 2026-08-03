import { useEffect, useMemo, useRef } from 'react';
import type { SlotDeclInput } from '@sentientui/core';
import { validateSlotDecl } from '@sentientui/policy';
import { useAdaptiveApiKey, useSentient } from './provider.js';
import { useSlotResult } from './use-slot-result.js';
import { registerSlot } from './devtools-registry.js';
import {
  attachGoalListeners,
  goalLabelOf,
  isDevBuild,
  normalizeGoal,
  trackExposure,
  type GoalConfig,
} from './adaptive-shared.js';

export type UseAdaptiveTokensOptions = { goal?: string | GoalConfig };
export type UseAdaptiveTokensResult = {
  tokens: Record<string, string>;
  /** Spread on the slot's element: `data-<dim>` per dim + `data-sentient-slot`. */
  props: Record<string, string>;
};

// Warn once per slot id per page lifetime — not per render.
const warnedTokenSlots = new Set<string>();

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  // Fallback for environments without CSS.escape: the value is interpolated
  // inside a double-quoted attribute selector (`[data-sentient-slot="…"]`), so
  // both the backslash and the closing quote must be escaped — the old
  // quote-only escape let a slot id containing `\` break out of the selector
  // (and an unescaped `"` in a since-fixed path could match the wrong node).
  return value.replace(/[\\"]/g, '\\$&');
}

/**
 * Rung 1b — adaptive design tokens. Declares a bounded token space; the
 * optimizer picks per persona; values apply as element-scoped data
 * attributes so they serialize through SSR markup (zero flicker,
 * hydration-safe). First value of each dim = baseline.
 *
 * ```tsx
 * const t = useAdaptiveTokens('hero', { tone: ['calm', 'urgent'] });
 * return <section {...t.props} className="hero">…</section>;
 * // CSS: .hero[data-tone="urgent"] .cta { … }
 * ```
 */
export function useAdaptiveTokens(
  id: string,
  dims: Record<string, readonly string[]>,
  opts?: UseAdaptiveTokensOptions,
): UseAdaptiveTokensResult {
  const client = useSentient();
  const apiKey = useAdaptiveApiKey();

  // Freeze the declaration on the DIMS SIGNATURE, not the object identity: an
  // inline `dims={{...}}` literal is a fresh object each render, so keying on it
  // would churn a new decl every commit. A stringified signature is stable
  // across renders for the same dims yet updates if the declared space changes
  // (same convention as <Adaptive> / useAdaptive / AdaptiveGroup). A slot's
  // declared space is normally fixed for the session.
  const dimsKey = JSON.stringify(dims);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const decl = useMemo<SlotDeclInput>(() => ({ id, dims }), [id, dimsKey]);
  const { result, arm, source } = useSlotResult(id, decl);
  const tokens = useMemo<Record<string, string>>(
    () => (typeof result === 'string' ? {} : result),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [arm],
  );

  if (isDevBuild() && !warnedTokenSlots.has(id)) {
    const validity = validateSlotDecl({
      id,
      dims: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, [...v]])),
    });
    const space = Object.values(dims).reduce((n, values) => n * values.length, 1);
    if (!validity.ok) {
      warnedTokenSlots.add(id);
      console.warn(
        `[sentient] useAdaptiveTokens("${id}"): invalid declaration — ${validity.reason}. Serving baseline.`,
      );
    } else if (space > 4) {
      warnedTokenSlots.add(id);
      console.warn(
        `[sentient] useAdaptiveTokens("${id}") declares ${space} combinations — more than the recommended 4. Each extra combination needs more traffic to learn; consider fewer dims/values.`,
      );
    }
  }

  const goalKey =
    opts?.goal === undefined ? null : typeof opts.goal === 'string' ? opts.goal : JSON.stringify(opts.goal);

  // Devtools slot registry — the declared dims space drives both persona
  // simulation and the panel's per-dim override buttons. A slot is NOT a
  // component: registering it as one produced buttons that wrote the wrong
  // override channel (`__sentient_overrides` instead of `__sentient_slot_overrides`).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => registerSlot({ id, dims }), [id]);

  // Exposure — the slot equivalent of <Adaptive>'s variant_assigned event,
  // once per (slot, arm). variantId = canonical arm string.
  const exposedArmRef = useRef<string | null>(null);
  useEffect(() => {
    // Don't expose an unresolved baseline: a `baseline` source means the slot
    // was never decided (interim local decide, or a keyed client with no SSR
    // preload). Recording it accrues a phantom baseline impression that can
    // never convert. Once a real arm resolves (source flips to preloaded/
    // client) the exposure fires for that arm.
    // A forced arm (`override`, from devtools/tests) is a preview, not a real
    // exposure — recording it would train the optimizer on the override, the
    // same "no events, weights unchanged" contract <Adaptive> honors for
    // component overrides.
    if (!client || source === 'baseline' || source === 'override' || exposedArmRef.current === arm) return;
    exposedArmRef.current = arm;
    trackExposure(client, apiKey, id, arm);
  }, [client, apiKey, id, arm, source]);

  // Optional goal: the returned props carry data-sentient-slot, so the slot's
  // element is findable without a ref (the pinned return type has no ref).
  // Credit flows through componentGoal(slot id) — the core resolves the
  // attributed arm from its slot state (Task 3.3 fallback).
  useEffect(() => {
    // Forced arms record nothing (preview only) — same gate as the exposure.
    if (!client || !opts?.goal || source === 'override') return;
    const node = document.querySelector(`[data-sentient-slot="${cssEscape(id)}"]`);
    if (!node) {
      if (isDevBuild()) {
        console.warn(
          `[sentient] useAdaptiveTokens("${id}"): a goal is declared but no element carries the returned props — spread {...props} on the slot's element.`,
        );
      }
      return;
    }
    const label = goalLabelOf(opts.goal);
    let fired = false;
    return attachGoalListeners(node, normalizeGoal(opts.goal), {
      fireGoal: () => {
        if (fired) return;
        fired = true;
        // componentGoal credits the bandit (goal_achieved event, arm resolved
        // from slot state); goal() writes the session-level conversion funnel
        // record — exactly what <Adaptive> does for component goals. Slots
        // fired only the former, so slot conversions were invisible in the
        // goal funnel; fire both so membership matches components. (One funnel
        // record per conversion — see useAdaptiveGoal; keep labels unique.)
        client.componentGoal(id, label);
        client.goal(label, { componentId: id, arm }, 1.0, 0);
      },
      fireStep: (name, weight, stepIndex) => {
        client.componentGoal(id, name, { reward: weight });
        client.goal(name, { componentId: id, arm }, weight, stepIndex);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, id, goalKey, arm, source]);

  const props = useMemo(() => {
    const p: Record<string, string> = { 'data-sentient-slot': id };
    for (const [dim, value] of Object.entries(tokens)) p[`data-${dim}`] = value;
    return p;
  }, [id, tokens]);

  return { tokens, props };
}
