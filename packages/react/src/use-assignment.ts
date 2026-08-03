import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { type AssignResult } from '@sentientui/core';
import { useSentient, useInitialAssignments, useSessionSegment, useSsrFallback, useOnAssignment, useDebug } from './provider.js';
import { subscribe, getWeights, type ComponentWeights } from './weights-store.js';
import { subscribeOverridesChanged } from './override-events.js';
import { getDevOverride } from './dev-override.js';

export type AssignmentState = {
  variantId: string | null;
  /** Populated when the assigned variant is a dashboard-managed text variant. */
  content: string | null;
  isLoading: boolean;
  /**
   * True once `variantId` reflects a REAL decision — an SSR preload, the local
   * assignment cache, a server `assign()`, live bandit weights, or a dev
   * override — rather than the interim `variantIds[0]` placeholder shown while a
   * decision is still in flight. Exposure tracking MUST gate on this: emitting
   * `variant_assigned` for the placeholder accrues a phantom baseline
   * impression that can never convert and dilutes that arm's CVR.
   */
  settled: boolean;
  /**
   * True while a dev override (?sentient_variant= / window.__sentient_overrides)
   * is forcing this variant. Consumers must suppress ALL tracking while set —
   * the override contract is "no events recorded, weights unchanged".
   */
  isOverride?: boolean;
};

// Pseudo-count for the shrinkage prior below — the number of "prior" pulls at
// reward 0 mixed into every arm's mean. Large enough to sink a lucky 1-pull
// arm, small enough to be negligible once an arm has real traffic.
const PRIOR_PULLS = 5;

/**
 * Degraded-fallback selection from cached bandit weights (used only when the
 * server assignment hasn't resolved). Ranks arms by a posterior mean shrunk
 * toward a zero prior — `pulls·avgReward / (pulls + PRIOR_PULLS)` — so a lucky
 * small-sample arm (e.g. 1 pull at avgReward 1.0) can't outrank a well-sampled
 * one (500 pulls at 0.2). With equal pulls the shrinkage is monotonic in
 * avgReward, preserving plain "highest avgReward wins" behavior.
 */
function pickFromWeights(weights: ComponentWeights, variantIds: string[]): string | null {
  let best: { variantId: string; score: number } | null = null;
  for (const v of weights.variants) {
    if (!variantIds.includes(v.variantId)) continue;
    const pulls = v.pulls ?? 0;
    const score = pulls > 0 ? (pulls * v.avgReward) / (pulls + PRIOR_PULLS) : 0;
    if (!best || score > best.score) {
      best = { variantId: v.variantId, score };
    }
  }
  return best?.variantId ?? null;
}

/**
 * Returns a sticky variant assignment for a component.
 *
 * @deprecated Since 0.13.0 — use {@link useAdaptive} instead. `useAssignment`
 * only SELECTS a variant; it wires no exposure tracking, no goal listeners,
 * and no micro-signals, so components using it directly accumulate no
 * learning signal. It keeps working (it is `useAdaptive`'s internal
 * selection engine) but will move to internal-only in 1.0.0.
 *
 * First render reads the local SDK cache; if empty, falls back to a
 * deterministic default and asynchronously calls `/v1/assign`. The server
 * picks the actual variant via Thompson Sampling and the result replaces the fallback
 * on the next render. Subsequent paints read synchronously from cache —
 * no flicker, no loading state after first paint.
 */
export function useAssignment(componentId: string, variantIds: string[], agentData?: unknown, agentDataByVariant?: Record<string, unknown>): AssignmentState {
  const initialAssignments = useInitialAssignments();
  const ssrFallback = useSsrFallback();
  const client = useSentient();
  const segment = useSessionSegment();
  const onAssignment = useOnAssignment();
  const debug = useDebug();
  const assignmentReportedRef = useRef<string | null>(null);

  // Dev override (URL ?sentient_variant=componentId:variantId or
  // window.__sentient_overrides[componentId]) read through useSyncExternalStore:
  //  - server snapshot is null (no window), so SSR renders the un-forced variant;
  //  - the client snapshot reads the override, and React reconciles the two
  //    across hydration WITHOUT a mismatch (this is exactly what the hook is for);
  //  - unlike a post-mount flip it is already correct on a remount / CSR-nav, so
  //    a forced variant never leaks an interim assign() or exposure before the
  //    override applies.
  // It also re-renders when the devtools/scenario helpers bump the override bus.
  const devOverride = useSyncExternalStore(
    subscribeOverridesChanged,
    () => getDevOverride(componentId),
    () => null,
  );
  const overrideVariant = devOverride && variantIds.includes(devOverride) ? devOverride : null;
  const overrideLoggedRef = useRef<string | null>(null);
  // Diagnostic log for an active dev override — effect, never render body, and
  // gated behind the provider's debug flag so it stays silent in production.
  useEffect(() => {
    if (!debug) return;
    if (!overrideVariant) return;
    if (overrideLoggedRef.current === overrideVariant) return;
    overrideLoggedRef.current = overrideVariant;
    console.info(`[sentient] override active: ${componentId} -> ${overrideVariant}`);
  }, [debug, overrideVariant, componentId]);

  // Lazy initializer: this selection logic (URLSearchParams parse via the
  // override read above, cache + weights Map lookups) runs ONCE on mount, not
  // on every render. React only uses a useState initializer's value on first
  // render, so computing it eagerly each render was pure waste on every
  // <Adaptive>/useAdaptive re-render. Mirrors AdaptiveText's lazy seeds.
  const [state, setState] = useState<AssignmentState>((): AssignmentState => {
    if (overrideVariant) {
      return { variantId: overrideVariant, content: null, isLoading: false, settled: true };
    }
    // SSR / pre-hydration: no client yet. Use initialAssignments if provided so
    // the server and client first render agree on the same variant (no mismatch).
    if (!client) {
      const preloaded = initialAssignments[componentId];
      if (preloaded && variantIds.includes(preloaded)) {
        // Server-decided — a real assignment, safe to expose.
        return { variantId: preloaded, content: null, isLoading: false, settled: true };
      }
      if (ssrFallback === 'first' && variantIds.length > 0) {
        // SEO placeholder shown until the client resolves a real decision — NOT
        // settled, so no exposure fires for this interim baseline.
        return { variantId: variantIds[0], content: null, isLoading: false, settled: false };
      }
      return { variantId: null, content: null, isLoading: true, settled: false };
    }
    const cached = client.getAssignment(componentId, segment);
    // Allow cached managed variants (content present) even if not in variantIds.
    if (cached && (variantIds.includes(cached.variantId) || cached.content)) {
      return { variantId: cached.variantId, content: cached.content ?? null, isLoading: false, settled: true };
    }
    const weights = getWeights(componentId);
    if (weights) {
      const chosen = pickFromWeights(weights, variantIds);
      if (chosen) return { variantId: chosen, content: null, isLoading: false, settled: true };
    }
    // Interim placeholder while the async assign() below is in flight — not a
    // real decision yet, so it stays unsettled and emits no exposure.
    return { variantId: variantIds[0] ?? null, content: null, isLoading: false, settled: false };
  });

  // Helper: call onAssignment at most once per resolved variant.
  const reportAssignment = (variantId: string): void => {
    if (!onAssignment) return;
    if (assignmentReportedRef.current === variantId) return;
    assignmentReportedRef.current = variantId;
    onAssignment(componentId, variantId);
  };

  // As soon as the client is ready, unblock the UI immediately with variantIds[0]
  // (or a cached value) so the component never stays invisible while assign is
  // in-flight. The async assign call below then swaps to the bandit-chosen variant.
  useEffect(() => {
    if (overrideVariant) return;
    if (!client) return;
    const cached = client.getAssignment(componentId, segment);
    if (cached && (variantIds.includes(cached.variantId) || cached.content)) {
      setState({ variantId: cached.variantId, content: cached.content ?? null, isLoading: false, settled: true });
      reportAssignment(cached.variantId);
      return;
    }
    setState((prev) => prev.variantId ? prev : { variantId: variantIds[0] ?? null, content: null, isLoading: false, settled: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideVariant, client, componentId, segment]);

  // Ask the server for a real assignment when we have a client but no cached one.
  useEffect(() => {
    if (overrideVariant) return;
    if (!client) return;
    const cached = client.getAssignment(componentId, segment);
    if (cached && variantIds.includes(cached.variantId)) return;

    let cancelled = false;
    void client.assign(componentId, variantIds, agentData, agentDataByVariant).then((result: AssignResult | null) => {
      if (cancelled) return;
      if (!result) return;
      // Allow the result if it's a known code variant OR a managed text variant (has content).
      if (!variantIds.includes(result.variantId) && !result.content) return;
      setState({ variantId: result.variantId, content: result.content ?? null, isLoading: false, settled: true });
      reportAssignment(result.variantId);
    });
    return () => { cancelled = true; };
    // variantIds intentionally excluded — changing variants mid-mount is unsupported
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideVariant, client, componentId, segment]);

  // Live weight updates from the dashboard SSE stream (when wired).
  useEffect(() => {
    if (overrideVariant) return;
    if (!client) return;
    return subscribe(componentId, (weights) => {
      const cached = client.getAssignment(componentId, segment);
      if (cached && (variantIds.includes(cached.variantId) || cached.content)) {
        setState({ variantId: cached.variantId, content: cached.content ?? null, isLoading: false, settled: true });
        return;
      }
      const chosen = pickFromWeights(weights, variantIds);
      if (chosen) setState({ variantId: chosen, content: null, isLoading: false, settled: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideVariant, client, componentId, segment]);

  if (overrideVariant) {
    return { variantId: overrideVariant, content: null, isLoading: false, settled: true, isOverride: true };
  }

  return state;
}
