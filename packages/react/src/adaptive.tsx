'use client';

// `type JSX` from react, not the global namespace removed in @types/react@19
// (peers allow react >=18) — see adaptive-text.tsx.
import { memo, useEffect, useState, type JSX, type ReactNode } from 'react';
import { useVariantComponent, type MicroSignalGoals } from './use-variant-component.js';
import { AdaptiveSlot, type AdaptiveSlotProps } from './adaptive-slot.js';

export type {
  ScrollDepthGoal,
  ClickGoal,
  FormSubmitGoal,
  CompositeGoal,
  WeightedStep,
  WeightedCompositeGoal,
  GoalConfig,
} from './adaptive-shared.js';
import { isDevBuild, type GoalConfig } from './adaptive-shared.js';

export type { MicroSignalGoalConfig, MicroSignalGoals } from './use-variant-component.js';

/** `<Adaptive>` with variants written in code — each key an arm, first key the control. */
export type AdaptiveVariantsProps = {
  id: string;
  variants: Record<string, ReactNode>;
  children?: never;
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

/**
 * `<Adaptive>` without `variants`: the children are your original, and the
 * versions come from the dashboard (generated per visitor type, no redeploy).
 */
export type AdaptiveGeneratedProps = Omit<AdaptiveSlotProps, 'children'> & {
  children: ReactNode;
  variants?: undefined;
};

export type AdaptiveProps = AdaptiveVariantsProps | AdaptiveGeneratedProps;

function AdaptiveImpl(props: AdaptiveVariantsProps): JSX.Element | null {
  // Exposure, funnel, goal listeners, cursor + micro-signals all live in the
  // engine shared with useAdaptive, so a gate added for one applies to both.
  const { client, variantId, content, ref } = useVariantComponent(props.id, props.variants, {
    goal: props.goal,
    funnel: props.funnel,
    microSignalGoals: props.microSignalGoals,
    agentData: props.agentData,
    agentDataByVariant: props.agentDataByVariant,
    cursorSignal: true,
  });
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

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
    <div ref={ref} data-sentient-id={props.id} data-sentient-variant={variantId}>
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
const AdaptiveVariants = memo(AdaptiveImpl, (prev, next) => {
  if (prev.id !== next.id) return false;
  // Serialize only when the goal reference actually changed — a stable/memoized
  // goal (the common case) skips the stringify entirely.
  if (prev.goal !== next.goal && JSON.stringify(prev.goal) !== JSON.stringify(next.goal)) return false;
  if (prev.microSignalGoals !== next.microSignalGoals) return false;
  // `funnel` feeds the funnel-declaration effect: omitting it here swallowed a
  // funnel added or changed after first render (the memo skipped the re-render
  // that would have re-run the declaration).
  if (prev.funnel !== next.funnel) return false;
  if (prev.clientOnly !== next.clientOnly) return false;
  if (prev.agentData !== next.agentData) return false;
  if (prev.agentDataByVariant !== next.agentDataByVariant) return false;
  if (prev.variants === next.variants) return true;
  const prevKeys = Object.keys(prev.variants);
  const nextKeys = Object.keys(next.variants);
  if (prevKeys.length !== nextKeys.length) return false;
  return prevKeys.every((k) => k in next.variants && Object.is(prev.variants[k], next.variants[k]));
});

/**
 * One component, two ways to fill it. Without `variants`, the children are the
 * original and SentientUI serves dashboard-generated versions (the slot path —
 * what `<AdaptiveSlot>` was). With `variants`, the arms are the JSX you wrote.
 * The two stay separate optimizers underneath (slot_decisions vs the variant
 * bandit, CONTRACTS §1–§2); only the API is shared. Switching a mounted element
 * between modes remounts it, which is the honest behaviour: it becomes a
 * different experiment.
 */
export function Adaptive(props: AdaptiveProps): JSX.Element | null {
  if (props.variants === undefined) return <AdaptiveSlot {...props} />;
  if (isDevBuild() && (props as { children?: ReactNode }).children != null) {
    // JS callers bypass the `children?: never` type: say which one wins rather
    // than silently dropping the markup they wrapped.
    console.warn(`[sentient] <Adaptive id="${props.id}"> got both variants and children — rendering variants; children are ignored.`);
  }
  return <AdaptiveVariants {...props} />;
}
