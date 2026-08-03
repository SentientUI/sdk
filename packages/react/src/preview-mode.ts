import type { SentientClient } from '@sentientui/core';

type PreviewState = { on: boolean; listeners: Set<() => void> };
const ssrFallback: PreviewState = { on: false, listeners: new Set() };

// Window-backed: the /devtools entry (a separate bundle) toggles preview mode
// and the provider (main bundle) must observe it.
function state(): PreviewState {
  if (typeof window === 'undefined') return ssrFallback;
  const w = window as unknown as { __sentient_preview?: PreviewState };
  if (!w.__sentient_preview) w.__sentient_preview = { on: false, listeners: new Set() };
  return w.__sentient_preview;
}

export function setPreviewMode(on: boolean): void {
  const s = state();
  if (s.on === on) return;
  s.on = on;
  for (const fn of s.listeners) fn();
}

export function getPreviewMode(): boolean {
  return state().on;
}

export function subscribePreview(fn: () => void): () => void {
  const listeners = state().listeners;
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Wraps a client so it writes nothing: reads pass through, all emitters no-op.
 * Used while previewing variants/personas so no `variant_assigned`, goal, or
 * session events are sent.
 */
export function createPreviewClient(inner: SentientClient): SentientClient {
  return {
    isLocal: inner.isLocal,
    track: () => undefined,
    goal: () => undefined,
    componentGoal: () => undefined,
    identify: () => undefined,
    fetchWeights: () => Promise.resolve([]),
    getAssignment: (componentId, segment) => inner.getAssignment(componentId, segment),
    assign: (componentId, variantIds, agentData, agentDataByVariant) =>
      inner.assign(componentId, variantIds, agentData, agentDataByVariant),
    // Reads pass through; decide is a write (slot decisions persist server-side)
    // so preview mode never issues it.
    decide: () => Promise.resolve(null),
    getSlotResult: (slotId) => inner.getSlotResult(slotId),
    getPersona: () => inner.getPersona(),
    getGraph: () => inner.getGraph(),
    dispose: () => inner.dispose(),
    destroy: () => inner.destroy(),
  };
}
