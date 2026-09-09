import { useEffect, useReducer, useSyncExternalStore } from 'react';
import { armOfResult, type SitePalette, type SlotConfigEntry, type SlotResult } from '@sentientui/core';
import { useInitialPalette, useInitialSlotConfig, useInitialSlots, useSentient } from './provider.js';
import { subscribeOverridesChanged } from './override-events.js';
import { isDevBuild } from './adaptive-shared.js';

// Warn once per slot id per page lifetime, not per render.
const warnedUnservedSlots = new Set<string>();

declare global {
  interface Window {
    /** Test/devtools forcing: slot id → forced config entry (applyScenario sets this). */
    __sentient_slot_config_overrides?: Record<string, SlotConfigEntry>;
  }
}

export type SlotConfigResolution = {
  config: SlotConfigEntry | null;
  /** Served arm for the slot ('' when unknown). */
  arm: string;
  palette: SitePalette | null;
  source: 'override' | 'preloaded' | 'client' | 'none';
};

/**
 * Internal. Resolves the registry slot config AdaptiveSlot renders, synchronously:
 * test/devtools override → SSR-preloaded `initialSlotConfig` → core client state
 * (registry decide, snapshot seed) → none (render baseline children).
 * Purely read-side: exposure/goal wiring belongs to AdaptiveSlot.
 */
export function useSlotConfig(slotId: string): SlotConfigResolution {
  const client = useSentient();
  const initialSlots = useInitialSlots();
  const initialSlotConfig = useInitialSlotConfig();
  const initialPalette = useInitialPalette();
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // Same useSyncExternalStore discipline as useSlotResult: the server snapshot
  // returns undefined so SSR HTML and the pre-hydration client render agree
  // even when a Playwright/Cypress mock wrote the override before hydration.
  // The snapshot returns the stored object by reference (stable until the
  // override bus notifies), so it passes React's Object.is caching check.
  const overrideConfig = useSyncExternalStore(
    subscribeOverridesChanged,
    () => (typeof window !== 'undefined' ? window.__sentient_slot_config_overrides?.[slotId] : undefined),
    () => undefined,
  );
  const overrideResult = useSyncExternalStore(
    subscribeOverridesChanged,
    () => (typeof window !== 'undefined' ? window.__sentient_slot_overrides?.[slotId] : undefined),
    () => undefined,
  );

  const preloaded = overrideConfig === undefined ? initialSlotConfig[slotId] : undefined;
  const fromClient =
    overrideConfig === undefined && preloaded === undefined && client ? client.getSlotConfig(slotId) : null;

  const armOf = (r: SlotResult | null | undefined): string => (r == null ? '' : armOfResult(r));
  const palette = initialPalette ?? client?.getSitePalette() ?? null;

  // Keyless local mode on a CSR-only page: nothing has served this slot yet, so
  // issue one registry-mode decide — identical bodies coalesce in core, so N
  // mounted AdaptiveSlots in the same tick produce one request. Keyed clients
  // never take this path: registry slots decide server-side (SSR preload).
  const needsLocalDecide =
    client?.isLocal === true && overrideConfig === undefined && preloaded === undefined && fromClient === null;
  useEffect(() => {
    if (!needsLocalDecide || !client) return;
    let cancelled = false;
    void client.decide({ slotsFrom: 'registry' }).then((outcome) => {
      if (!cancelled && outcome) bump();
    });
    return () => {
      cancelled = true;
    };
  }, [client, slotId, needsLocalDecide]);

  const resolution: SlotConfigResolution = (() => {
    if (overrideConfig !== undefined) {
      return { config: overrideConfig, arm: armOf(overrideResult), palette, source: 'override' };
    }
    if (preloaded !== undefined) {
      return { config: preloaded, arm: armOf(initialSlots[slotId] ?? client?.getSlotResult(slotId)), palette, source: 'preloaded' };
    }
    if (fromClient !== null) {
      return { config: fromClient, arm: armOf(client?.getSlotResult(slotId) ?? initialSlots[slotId]), palette, source: 'client' };
    }
    return { config: null, arm: '', palette, source: 'none' };
  })();

  // First-seen registration: a keyed client with no config for this slot
  // reports the id so it auto-registers server-side as a draft — the matrix
  // grows the column before anything is live in it. Core batches and dedupes;
  // repeats are free.
  useEffect(() => {
    if (!client || client.isLocal === true || resolution.source !== 'none') return;
    client.reportSlots([slotId]);
  }, [client, resolution.source, slotId]);

  // Dev-only: a live KEYED client with no config means this AdaptiveSlot will
  // render its baseline children all session — keyed clients get slotConfig
  // only from an SSR registry-mode preload, and (unlike local mode) issue no
  // client-side decide. Warn once so the integrator preloads the decision.
  useEffect(() => {
    if (!isDevBuild()) return;
    if (!client || client.isLocal === true) return;
    if (resolution.source !== 'none') return;
    if (warnedUnservedSlots.has(slotId)) return;
    warnedUnservedSlots.add(slotId);
    console.warn(
      `[sentient] AdaptiveSlot "${slotId}" has no server config — rendering its baseline children. ` +
        `Preload it via loadAdaptiveDecision({ slotsFrom: 'registry' }) and pass initialSlotConfig/initialSlots ` +
        `to <AdaptiveProvider> so it can serve a decided arm and learn.`,
    );
  }, [client, resolution.source, slotId]);

  return resolution;
}
