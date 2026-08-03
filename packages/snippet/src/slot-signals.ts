import { attachMicroSignalDetectors } from '@sentientui/core';

// Per-option behavior signals: tag micro-signals with the slot/arm they occurred
// on (componentId = slotId, variantId = arm — the same overload convention the
// conversion join uses). Section-level capture (nc-<type>) is untouched; these
// are additional, element-scoped detectors on the applied slot elements. They
// feed the dashboard's per-option "how visitors behave" and never affect scores.

const HOVER_MS = 800; // mirrors the <Adaptive> cursor_signal threshold

type TrackClient = {
  track(event: {
    projectId: string;
    componentId: string;
    variantId?: string;
    eventType: string;
    payload?: Record<string, unknown>;
  }): void;
};

export type AppliedSlot = { slotId: string; arm: string; el: Element };

/**
 * Attach behavior detectors to each applied slot element, emitting signals
 * attributed to that slot/arm. Returns a cleanup that detaches everything.
 * Fail-safe: a throwing tracker never breaks the host page.
 */
export function attachSlotSignals(
  client: TrackClient,
  apiKey: string,
  applied: AppliedSlot[],
): () => void {
  const cleanups: Array<() => void> = [];

  applied.forEach(({ slotId, arm, el }, index) => {
    // The four micro-signals (rage click, text copy, scroll hesitation, tab loss).
    // Element-scoped signals (rage/copy/scroll) attribute correctly per node, but
    // tab_loss is a single document-level event: enabling it on every applied node
    // would emit one tab_loss per option on a single tab-hide, inflating "Quick
    // exits" for options the visitor never looked at. Enable it on just the first
    // node so the page-level exit is recorded once (audit M5).
    cleanups.push(
      attachMicroSignalDetectors((signalType, extra = {}) => {
        try {
          client.track({
            projectId: apiKey,
            componentId: slotId,
            variantId: arm,
            eventType: 'micro_signal',
            payload: { signalType, ...extra },
          });
        } catch {
          /* fail-safe */
        }
      }, el, undefined, { tabLoss: index === 0 }),
    );

    // Long hovers (cursor_signal) — the snippet's first source of this signal;
    // mirrors the <Adaptive> 800ms hover timer.
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let hoverStart = 0;
    const onEnter = (): void => {
      hoverStart = Date.now();
      timerId = setTimeout(() => {
        try {
          client.track({
            projectId: apiKey,
            componentId: slotId,
            variantId: arm,
            eventType: 'cursor_signal',
            payload: { hoverDuration: Date.now() - hoverStart },
          });
        } catch {
          /* fail-safe */
        }
        timerId = null;
      }, HOVER_MS);
    };
    const onLeave = (): void => {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
    };
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    cleanups.push(() => {
      el.removeEventListener('mouseenter', onEnter);
      el.removeEventListener('mouseleave', onLeave);
      if (timerId !== null) clearTimeout(timerId);
    });
  });

  return () => {
    for (const c of cleanups) c();
  };
}
