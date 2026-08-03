export type MicroSignalEmitter = (
  signalType: 'rage_click' | 'text_copy' | 'scroll_hesitation' | 'tab_loss',
  extra?: Record<string, unknown>,
) => void;

export type MicroSignalType = Parameters<MicroSignalEmitter>[0];

/**
 * Attaches passive behavioral detectors to `node`. Calls `emit` when a signal
 * fires. Each signal type fires at most once per call to this function.
 * Returns a cleanup function that removes all listeners.
 */
export function attachMicroSignalDetectors(
  emit: MicroSignalEmitter,
  node: Element,
  variantAssignedAt?: number,
  options?: { tabLoss?: boolean },
): () => void {
  const cleanups: Array<() => void> = [];

  // --- Rage click: 3+ clicks within 500ms ---
  {
    const WINDOW_MS = 500;
    const THRESHOLD = 3;
    let firedOnce = false;
    const timestamps: number[] = [];

    const onClick = (): void => {
      if (firedOnce) return;
      const now = Date.now();
      timestamps.push(now);
      while (timestamps.length > 0 && now - timestamps[0]! > WINDOW_MS) {
        timestamps.shift();
      }
      if (timestamps.length >= THRESHOLD) {
        firedOnce = true;
        emit('rage_click');
      }
    };

    node.addEventListener('click', onClick);
    cleanups.push(() => node.removeEventListener('click', onClick));
  }

  // --- Text copy: copy event within node ---
  {
    let firedOnce = false;

    const onCopy = (e: Event): void => {
      if (firedOnce) return;
      if (!(e.target instanceof Node)) return;
      if (!node.contains(e.target) && node !== e.target) return;
      firedOnce = true;
      const sel = typeof window !== 'undefined' ? window.getSelection() : null;
      const selectionLength = sel ? sel.toString().length : 0;
      emit('text_copy', { selectionLength });
    };

    document.addEventListener('copy', onCopy);
    cleanups.push(() => document.removeEventListener('copy', onCopy));
  }

  // --- Scroll hesitation: scroll stops 3s while component visible ---
  {
    let firedOnce = false;
    let isVisible = false;
    let hesitationTimer: ReturnType<typeof setTimeout> | null = null;

    const clearHesitation = (): void => {
      if (hesitationTimer !== null) {
        clearTimeout(hesitationTimer);
        hesitationTimer = null;
      }
    };

    const startHesitation = (): void => {
      if (firedOnce || !isVisible) return;
      clearHesitation();
      hesitationTimer = setTimeout(() => {
        if (!firedOnce && isVisible) {
          firedOnce = true;
          emit('scroll_hesitation');
        }
      }, 3000);
    };

    const onScroll = (): void => {
      clearHesitation();
      startHesitation();
    };

    const ioCallback = (entries: IntersectionObserverEntry[]): void => {
      for (const entry of entries) {
        isVisible = entry.intersectionRatio > 0.3;
        if (!isVisible) clearHesitation();
        else startHesitation();
      }
    };
    const io = new IntersectionObserver(ioCallback, { threshold: [0.3] });
    io.observe(node);
    window.addEventListener('scroll', onScroll, { passive: true });

    cleanups.push(() => {
      io.disconnect();
      window.removeEventListener('scroll', onScroll);
      clearHesitation();
    });
  }

  // --- Tab loss: tab hidden within 15s of variant_assigned ---
  // Document-level (not node-scoped), so callers that attach detectors to many
  // nodes at once (e.g. the snippet's per-option slot signals) can opt out on all
  // but one node to avoid emitting a duplicate tab_loss per node (audit M5).
  if (options?.tabLoss !== false) {
    let firedOnce = false;
    const assignedAt = variantAssignedAt ?? Date.now();

    const onVisibility = (): void => {
      if (firedOnce) return;
      if (document.visibilityState !== 'hidden') return;
      const elapsed = Date.now() - assignedAt;
      if (elapsed < 15_000) {
        firedOnce = true;
        emit('tab_loss', { timeOnPage: elapsed });
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
  }

  return () => {
    for (const c of cleanups) c();
  };
}
