import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { armOfResult, type RenderCaps, type SitePalette, type SkeletonReport, type SlotConfigEntry, type SlotResult, type StyleVocabulary } from '@sentientui/core';
import { useInitialPalette, useInitialSlotConfig, useInitialSlots, useInitialVocabulary, useSentient } from './provider.js';
import { subscribeOverridesChanged } from './override-events.js';
import { getVocabularyOverride } from './devtools-slot-config-overrides.js';
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
  /** Site styles served Redesign arms borrow (SSR seed, else the client's). */
  vocabulary: StyleVocabulary | null;
  /**
   * `client` = decided for this session; `seeded` = the core holds config
   * from an earlier visit's snapshot that this session has not decided yet.
   * Seeded config renders (pre-paint parity) but is not exposed or credited —
   * there is no slot_decisions row for it until requestSlots answers.
   */
  source: 'override' | 'preloaded' | 'client' | 'seeded' | 'none';
};

/**
 * Internal. Resolves the registry slot config AdaptiveSlot renders, synchronously:
 * test/devtools override → SSR-preloaded `initialSlotConfig` → core client state
 * (registry decide, snapshot seed) → none (render baseline children).
 * Purely read-side: exposure/goal wiring belongs to AdaptiveSlot.
 */
export function useSlotConfig(
  slotId: string,
  opts?: {
    /** Read the region's rendered baseline text at registration time (only
     *  called when the slot is unserved and about to self-register). Kept in
     *  a ref so an inline arrow never re-fires the effect. */
    baselineText?: () => string | null;
    /** What this mounted slot can render (CONTRACTS §2) — sent with the
     *  scoped decide so the server never draws an arm the page would refuse. */
    render?: () => RenderCaps;
    /** Capture the region's skeleton. Only called while the wrapper shows the
     *  developer's children — never an arm's rendering of them. */
    skeleton?: () => SkeletonReport | null;
  },
): SlotConfigResolution {
  const client = useSentient();
  const baselineTextRef = useRef(opts?.baselineText);
  baselineTextRef.current = opts?.baselineText;
  const renderRef = useRef(opts?.render);
  renderRef.current = opts?.render;
  const skeletonRef = useRef(opts?.skeleton);
  skeletonRef.current = opts?.skeleton;
  const initialSlots = useInitialSlots();
  const initialSlotConfig = useInitialSlotConfig();
  const initialPalette = useInitialPalette();
  const initialVocabulary = useInitialVocabulary();

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

  const armOf = (r: SlotResult | null | undefined): string => (r == null ? '' : armOfResult(r));

  // Re-render when the client's slot state changes — a mounted-slot decide
  // (requestSlots) answers after first paint. Values are still read below;
  // these two hooks only make React notice the change. Both snapshots are
  // stable between notifications (stored object by reference / arm string).
  const subscribeSlots = useCallback(
    (cb: () => void) => client?.onSlotsChanged?.(cb) ?? (() => undefined),
    [client],
  );
  useSyncExternalStore(subscribeSlots, () => client?.getSlotConfig(slotId) ?? null, () => null);
  useSyncExternalStore(subscribeSlots, () => armOf(client?.getSlotResult(slotId)), () => '');

  const preloaded = overrideConfig === undefined ? initialSlotConfig[slotId] : undefined;
  const fromClient =
    overrideConfig === undefined && preloaded === undefined && client ? client.getSlotConfig(slotId) : null;

  const palette = initialPalette ?? client?.getSitePalette() ?? null;
  const vocabulary = initialVocabulary ?? client?.getStyleVocabulary?.() ?? null;

  // No local-mode decide here, deliberately: the local engine has no registry
  // concept — decide({ slotsFrom: 'registry' }) ran the whole engine once per
  // mounted slot and could never produce a slotConfig (local getSlotConfig
  // reads only the initialSlotConfig SSR seed). Local slots resolve
  // synchronously from that seed or fall through to children; the dev warning
  // below says so instead of burning an engine run per mount.

  const resolution: SlotConfigResolution = (() => {
    if (overrideConfig !== undefined) {
      return { config: overrideConfig, arm: armOf(overrideResult), palette, vocabulary: getVocabularyOverride() ?? vocabulary, source: 'override' };
    }
    if (preloaded !== undefined) {
      return { config: preloaded, arm: armOf(initialSlots[slotId] ?? client?.getSlotResult(slotId)), palette, vocabulary, source: 'preloaded' };
    }
    if (fromClient !== null) {
      const decided = client?.isSlotDecided ? client.isSlotDecided(slotId) : true;
      return {
        config: fromClient,
        arm: armOf(client?.getSlotResult(slotId) ?? initialSlots[slotId]),
        palette,
        vocabulary,
        source: decided ? 'client' : 'seeded',
      };
    }
    return { config: null, arm: '', palette, vocabulary, source: 'none' };
  })();

  // Keyed clients ask the server for THIS mounted slot: one decide scoped to
  // the ids actually on the page (batched per commit), which also registers it
  // as a draft when nothing is published. This used to be registration only —
  // no client-side registry decide existed, so outside an SSR registry preload
  // (which AdaptiveRoot never did) a slot rendered its children forever and
  // never served a generated version. Snapshot-seeded ('client') slots still
  // ask: the snapshot is the last visit's answer, and this session needs its
  // own decision (or to learn the slot was unpublished). Preloaded and forced
  // slots already have this session's answer.
  const settled = resolution.source === 'preloaded' || resolution.source === 'override';
  useEffect(() => {
    if (!client || client.isLocal === true || settled) return;
    // Children are on screen only while unserved — that is the only moment the
    // wrapper's text is the baseline generation should be grounded in.
    const unserved = resolution.source === 'none';
    const text = unserved ? baselineTextRef.current?.() ?? null : null;
    const texts = text != null && text !== '' ? { [slotId]: text } : undefined;
    const caps = renderRef.current?.();
    const skeleton = unserved ? skeletonRef.current?.() ?? null : null;
    // Trailing arguments only when there is something to send: hand-rolled
    // clients and older cores see exactly the call they always did.
    const extras = {
      ...(caps ? { render: { [slotId]: caps } } : {}),
      ...(skeleton ? { skeletons: { [slotId]: skeleton } } : {}),
    };
    const hasExtras = Object.keys(extras).length > 0;
    if (client.requestSlots) {
      if (hasExtras) client.requestSlots([slotId], texts, extras);
      else if (texts) client.requestSlots([slotId], texts);
      else client.requestSlots([slotId]);
    } else if (unserved) {
      if (skeleton) client.reportSlots([slotId], texts ?? {}, { [slotId]: skeleton });
      else if (texts) client.reportSlots([slotId], texts);
      else client.reportSlots([slotId]);
    }
    // Unmounted before the batch was sent (redirecting route, StrictMode
    // probe): withdraw it — a slot that is not on the page is not a trial.
    return () => client.cancelSlots?.([slotId]);
  }, [client, settled, resolution.source, slotId]);

  // Dev-only: local/keyless mode has no registry, so an unserved slot renders
  // its children all session and looks identical to a healthy holdout.
  useEffect(() => {
    if (!isDevBuild() || client?.isLocal !== true || resolution.source !== 'none') return;
    if (warnedUnservedSlots.has(slotId)) return;
    warnedUnservedSlots.add(slotId);
    console.warn(
      `[sentient] <Adaptive id="${slotId}"> is rendering its baseline children: in local/keyless mode ` +
        `<Adaptive> serves ONLY what you pass as \`initialSlotConfig\` (there is no registry to decide from). ` +
        `Pass initialSlotConfig/initialSlots to <AdaptiveProvider> to preview arms locally.`,
    );
  }, [client, resolution.source, slotId]);

  return resolution;
}
