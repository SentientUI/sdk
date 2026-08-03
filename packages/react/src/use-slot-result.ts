import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { armOfResult, baselineResultFor, type SlotDeclInput, type SlotResult } from '@sentientui/core';
import { confidenceBand } from '@sentientui/policy';
import { useInitialPersona, useInitialSlots, useSentient } from './provider.js';
import { subscribeOverridesChanged, getOverridesVersion } from './override-events.js';
import { isDevBuild } from './adaptive-shared.js';

// Warn once per slot id per page lifetime, not per render.
const warnedBaselineSlots = new Set<string>();

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
  source: 'override' | 'preloaded' | 'client' | 'baseline';
};

/**
 * Internal. Resolves what a slot serves this render, synchronously:
 * test/devtools override → SSR-preloaded result → core client state
 * (decide cache, snapshot seed, failure baseline) → declared baseline.
 * Purely read-side: exposure/goal wiring belongs to the calling hook.
 */
export function useSlotResult(slotId: string, decl: SlotDeclInput): SlotResolution {
  // Re-render when devtools writes window.__sentient_slot_overrides.
  useSyncExternalStore(subscribeOverridesChanged, getOverridesVersion, () => 0);
  const client = useSentient();
  const initialSlots = useInitialSlots();
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const override =
    typeof window !== 'undefined' ? window.__sentient_slot_overrides?.[slotId] : undefined;
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
      return { result: fromClient, arm: armOfResult(fromClient), source: 'client' };
    }
    const baseline = baselineResultFor(decl);
    return { result: baseline, arm: armOfResult(baseline), source: 'baseline' };
  })();

  // Dev-only: a live KEYED client that has settled on the declared baseline was
  // never decided — keyed clients decide slots server-side (SSR preload), and
  // (unlike local mode) issue no client-side decide, so this slot serves
  // baseline for the whole session and cannot learn. Callers gate exposure on
  // `source !== 'baseline'` so no phantom baseline impression is recorded; warn
  // once so the integrator preloads the decision. (Local mode's baseline is a
  // transient first paint before its decide resolves — excluded here.)
  useEffect(() => {
    if (!isDevBuild()) return;
    if (!client || client.isLocal === true) return;
    if (resolution.source !== 'baseline') return;
    if (warnedBaselineSlots.has(slotId)) return;
    warnedBaselineSlots.add(slotId);
    console.warn(
      `[sentient] slot "${slotId}" resolved to its baseline — no SSR-preloaded or decided result. ` +
        `Keyed clients decide slots server-side, so this slot serves baseline for the whole session ` +
        `and records no exposure. Preload it via loadAdaptiveDecision()/initialSlots so it can serve a decided arm and learn.`,
    );
  }, [client, resolution.source, slotId]);

  return resolution;
}

/**
 * Reads a forced persona: `window.__sentient_persona_override` (the devtools
 * panel, `applyScenario`, the Playwright/Cypress helpers) or the
 * `?sentient_persona=<PersonaKey>` URL param (mirrors `?sentient_variant=`).
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
