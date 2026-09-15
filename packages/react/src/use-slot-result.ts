import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { armOfResult, baselineResultFor, type SlotDeclInput, type SlotResult } from '@sentientui/core';
import { confidenceBand } from '@sentientui/policy';
import { useInitialPersona, useInitialSlots, useSentient } from './provider.js';
import { subscribeOverridesChanged, getOverridesVersion } from './override-events.js';

declare global {
  interface Window {
    /** Test/devtools forcing: slot id → forced result (applyScenario sets this). */
    __sentient_slot_overrides?: Record<string, SlotResult>;
    /** Test/devtools forcing: forced persona (applyScenario sets this). */
    __sentient_persona_override?: { persona: string; confidence?: number };
  }
}

export type SlotResolution = {
  result: SlotResult;
  /** Canonical arm string (`dim=value|…` for dims slots, arm id for arms slots). */
  arm: string;
  /**
   * `client` = decided for this session (a slot_decisions row exists);
   * `seeded` = the core client holds a result that was NOT decided this
   * session — a snapshot from an earlier visit or the baseline it wrote when a
   * decide failed. Seeded results render (pre-paint parity) but must never be
   * exposed or credited: there is no trial for them to belong to.
   */
  source: 'override' | 'preloaded' | 'client' | 'seeded' | 'baseline';
};

/**
 * Internal. Resolves what a slot serves this render, synchronously:
 * test/devtools override → SSR-preloaded result → core client state
 * (decide cache, snapshot seed, failure baseline) → declared baseline.
 * Purely read-side: exposure/goal wiring belongs to the calling hook.
 */
export function useSlotResult(slotId: string, decl: SlotDeclInput): SlotResolution {
  const client = useSentient();
  const initialSlots = useInitialSlots();
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // Devtools/test forcing (window.__sentient_slot_overrides — applyScenario,
  // the Playwright/Cypress mocks) read through the useSyncExternalStore
  // SNAPSHOT with a null server snapshot, exactly like useAssignment's dev
  // override and useLayoutOrder. The old direct window read in the render body
  // made the pre-hydration client render disagree with the server HTML
  // whenever an override was written before hydration — which is precisely
  // when the package's own Playwright/Cypress mocks write it — i.e. a
  // hydration mismatch. The snapshot returns the stored object by reference
  // (stable until the override bus notifies a rewrite), so it passes React's
  // Object.is snapshot-caching check.
  const override = useSyncExternalStore(
    subscribeOverridesChanged,
    () => (typeof window !== 'undefined' ? window.__sentient_slot_overrides?.[slotId] : undefined),
    () => undefined,
  );
  const preloaded = override === undefined ? initialSlots[slotId] : undefined;
  const fromClient =
    override === undefined && preloaded === undefined && client
      ? client.getSlotResult(slotId)
      : null;

  // Keyless local mode on a CSR-only page: nothing has decided this slot yet
  // (no SSR preload, no snapshot), so ask the local engine — zero network,
  // deterministic — and re-render when the decision lands. Keyed clients
  // never take this path: their slots decide server-side (SSR preload).
  const needsLocalDecide =
    client?.isLocal === true &&
    override === undefined &&
    preloaded === undefined &&
    fromClient === null;
  useEffect(() => {
    if (!needsLocalDecide || !client) return;
    let cancelled = false;
    void client.decide({ slots: [decl] }).then((outcome) => {
      if (!cancelled && outcome) bump();
    });
    return () => {
      cancelled = true;
    };
    // decl identity is fixed per slot id (callers memoize it on id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, slotId, needsLocalDecide]);

  const resolution: SlotResolution = (() => {
    if (override !== undefined) {
      return { result: override, arm: armOfResult(override), source: 'override' };
    }
    if (preloaded !== undefined) {
      return { result: preloaded, arm: armOfResult(preloaded), source: 'preloaded' };
    }
    if (fromClient !== null) {
      // A result the core holds but did not decide this session (snapshot seed,
      // failure baseline) renders as-is but is `seeded`, so the exposure and
      // goal gates in the calling hooks skip it. Clients without the probe
      // (hand-rolled/test) read as decided, as before.
      const decided = client?.isSlotDecided ? client.isSlotDecided(slotId) : true;
      return { result: fromClient, arm: armOfResult(fromClient), source: decided ? 'client' : 'seeded' };
    }
    const baseline = baselineResultFor(decl);
    return { result: baseline, arm: armOfResult(baseline), source: 'baseline' };
  })();

  // Keyed clients decide THIS mounted slot when nothing preloaded it: one
  // batched decide per commit (core decideSlots), then re-render when it lands.
  // Before this a keyed client never decided request-declared slots in the
  // browser — useAdaptiveTokens and AdaptiveGroup served their baseline for the
  // whole session and learned nothing unless the same declaration was
  // duplicated into AdaptiveRoot's `slots` for SSR. Snapshot-seeded ('client')
  // slots still ask: the snapshot is the last visit's answer, not a decision
  // for this session. Only mounted slots are decided, so a declaration on
  // another page never becomes a trial for this visit.
  const settled = resolution.source === 'preloaded' || resolution.source === 'override';
  useEffect(() => {
    if (!client || client.isLocal === true || settled || !client.decideSlots) return;
    const off = client.onSlotsChanged?.(bump);
    client.decideSlots([decl]);
    return () => {
      // Unmounted before the batch was sent (redirecting route, StrictMode
      // probe): withdraw it — a slot that is not on the page is not a trial.
      client.cancelSlots?.([slotId]);
      off?.();
    };
    // decl identity is fixed per slot id (callers memoize it on id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, slotId, settled]);

  return resolution;
}

/**
 * Reads a forced persona: `window.__sentient_persona_override` (the devtools
 * panel, `applyScenario`, the Playwright/Cypress helpers) or the
 * `?sentient_persona=<persona key>` URL param (any project vocabulary key;
 * mirrors `?sentient_variant=`).
 * Read POST-MOUNT only — it touches `window.location`.
 */
function getPersonaOverride(): { persona: string; confidence: number } | null {
  if (typeof window === 'undefined') return null;
  const forced = window.__sentient_persona_override;
  if (forced?.persona) return { persona: forced.persona, confidence: forced.confidence ?? 1 };
  try {
    const value = new URLSearchParams(window.location.search).get('sentient_persona');
    if (value) return { persona: value, confidence: 1 };
  } catch {
    /* non-browser env */
  }
  return null;
}

export type AdaptivePersona = {
  persona: string;
  confidence: number;
  band: 'low' | 'medium' | 'high';
};

/**
 * The current persona estimate for React consumers, resolved in priority
 * order: a forced override (devtools / `applyScenario` / `?sentient_persona=`)
 * → the SSR-provided `initialPersona` → the live client estimate (adopted
 * attributes / snapshot / decide). Returns `null` when nothing is known yet.
 *
 * Hydration-safe: the first render (server + pre-hydration client) uses ONLY
 * the SSR-provided persona so server and client agree; the override channel and
 * the live client estimate — neither visible to the server — are read after
 * mount. Re-renders when a persona/variant override is written, so devtools or
 * a test forcing a persona mid-session takes effect immediately.
 */
export function useAdaptivePersona(): AdaptivePersona | null {
  const client = useSentient();
  const initialPersona = useInitialPersona();
  // Re-render when the override channel is written. NOTE: unlike useAssignment /
  // AdaptiveText — which fold the override into the useSyncExternalStore snapshot
  // (getDevOverride returns a STABLE string) — persona can't: getPersonaOverride
  // allocates a fresh object each call, which would fail the snapshot's Object.is
  // check and trip React's "getSnapshot should be cached" loop guard. So we
  // subscribe to the stable version counter for reactivity and read the override
  // in the render body (behind a mounted gate). That one-frame post-mount flip is
  // harmless here because this hook is side-effect-free (no assign/exposure to
  // leak), which is exactly why useAssignment/AdaptiveText could NOT tolerate it.
  useSyncExternalStore(subscribeOverridesChanged, getOverridesVersion, () => 0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const withBand = (p: { persona: string; confidence: number }): AdaptivePersona => ({
    persona: p.persona,
    confidence: p.confidence,
    band: confidenceBand(p.confidence),
  });

  // First render must match the server, which can see neither window nor the
  // client estimate — use only initialPersona to avoid a hydration mismatch on
  // a ?sentient_persona= page.
  if (!mounted) {
    return initialPersona ? withBand(initialPersona) : null;
  }
  const override = getPersonaOverride();
  if (override) return withBand(override);
  if (initialPersona) return withBand(initialPersona);
  const live = client ? client.getPersona() : null;
  return live ? withBand(live) : null;
}
