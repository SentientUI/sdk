/**
 * Keyless local mode — client factory.
 *
 * This module ships in the MAIN core bundle and contains no engine code: the
 * engine arrives through a dynamic import of the bare specifier
 * `@sentientui/core/local`, which the consumer's bundler resolves through the
 * development/production export conditions. In production builds that
 * specifier is the stub, and this client degrades to a no-op plus one
 * console.error per page load.
 */
import { initSession } from './session.js';
import { writeSnapshot } from './snapshot.js';
import { confidenceBand } from '@sentientui/policy';
import type {
  DecideOutcome,
  SentientClient,
  SentientConfig,
  SlotDeclInput,
} from './index.js';

type LocalEngineModule = {
  LOCAL_ENGINE_AVAILABLE: boolean;
  createLocalEngine(opts: { sessionId: string; forcedPersona?: string }): {
    decide(input: {
      sections?: string[];
      components?: Array<{ id: string; variantIds?: string[] }>;
      slots?: SlotDeclInput[];
    }): DecideOutcome;
  };
};

export const PROD_KEYLESS_ERROR =
  '[sentient] No API key configured — nothing is being learned. Set NEXT_PUBLIC_SENTIENT_API_KEY or pass localMode: true for local development.';

export const LOCAL_MODE_BANNER =
  '[sentient] Local mode — decisions are simulated on-device and nothing is sent over the network. Add an API key to learn from real traffic.';

// Once-per-page-load guards (module state resets on reload).
let bannerShown = false;
let prodErrorShown = false;

/** @internal test hook */
export function __resetLocalModeLogGuards(): void {
  bannerShown = false;
  prodErrorShown = false;
}

/** Mirrors the ?sentient_variant= override pattern; validated by the engine. */
function readPersonaOverrideFromUrl(): string | undefined {
  try {
    return new URLSearchParams(window.location.search).get('sentient_persona') ?? undefined;
  } catch {
    return undefined;
  }
}

export function createLocalModeClient(config: SentientConfig): SentientClient {
  const session = initSession({ ssrSessionId: config.ssrSessionId });
  const sessionId = session.getSessionId() ?? 'local';
  const forcedPersona = readPersonaOverrideFromUrl();

  // The specifier MUST stay a bare package subpath (never a relative path) so
  // the consumer's bundler applies the development/production export
  // conditions. tsup keeps it external (see tsup.config.ts).
  const modPromise: Promise<LocalEngineModule | null> = import('@sentientui/core/local')
    .then((mod) => {
      const m = mod as unknown as LocalEngineModule;
      if (!m.LOCAL_ENGINE_AVAILABLE) {
        if (!prodErrorShown) {
          prodErrorShown = true;
          console.error(PROD_KEYLESS_ERROR);
        }
        return null;
      }
      if (!bannerShown) {
        bannerShown = true;
        console.info(LOCAL_MODE_BANNER);
      }
      return m;
    })
    .catch(() => {
      if (!prodErrorShown) {
        prodErrorShown = true;
        console.error(PROD_KEYLESS_ERROR);
      }
      return null;
    });

  let lastOutcome: DecideOutcome | null = null;

  function applyPersonaAttributes(outcome: DecideOutcome): void {
    // Single-writer rule: adopt attributes already written (e.g. by the
    // AdaptiveRoot inline script); only write when nothing has yet.
    const el = document.documentElement;
    if (el.dataset.sentientPersona === undefined) {
      el.dataset.sentientPersona = outcome.persona;
      el.dataset.sentientConfidence = confidenceBand(outcome.confidence);
    }
  }

  return {
    isLocal: true,

    async decide(input) {
      const mod = await modPromise;
      if (!mod) return null;
      const outcome = mod.createLocalEngine({ sessionId, forcedPersona }).decide(input);
      // Accumulate across calls: slots decide lazily one at a time (per-slot
      // decide from useSlotResult), so a later decide must not evict results
      // an earlier one served. Same (sessionId, persona) → merging is safe.
      lastOutcome = {
        ...outcome,
        layoutOrder: outcome.layoutOrder ?? lastOutcome?.layoutOrder ?? null,
        slots: { ...(lastOutcome?.slots ?? {}), ...outcome.slots },
      };
      writeSnapshot(config.apiKey || 'local', {
        v: 1,
        persona: lastOutcome.persona,
        band: confidenceBand(lastOutcome.confidence),
        slots: lastOutcome.slots,
        layoutOrder: lastOutcome.layoutOrder,
        savedAt: Date.now(),
      });
      applyPersonaAttributes(outcome);
      return outcome;
    },

    getSlotResult(slotId) {
      return lastOutcome?.slots[slotId] ?? config.initialSlots?.[slotId] ?? null;
    },

    getPersona() {
      if (!lastOutcome) return null;
      return {
        persona: lastOutcome.persona,
        confidence: lastOutcome.confidence,
        band: confidenceBand(lastOutcome.confidence),
      };
    },

    async assign(componentId, variantIds) {
      const mod = await modPromise;
      if (!mod || !variantIds || variantIds.length === 0) {
        return variantIds?.[0] ? { variantId: variantIds[0], assignmentTtlMs: 0 } : null;
      }
      const outcome = mod
        .createLocalEngine({ sessionId, forcedPersona })
        .decide({ components: [{ id: componentId, variantIds }] });
      return { variantId: outcome.assignments[componentId] ?? variantIds[0], assignmentTtlMs: 0 };
    },

    // Local mode never talks to the network: the tracking surface no-ops.
    track: () => undefined,
    goal: () => undefined,
    componentGoal: () => undefined,
    identify: () => undefined,
    getAssignment: () => null,
    fetchWeights: () => Promise.resolve([]),
    getGraph: () => ({ pageNodes: [], capturedAt: 0 }),
    dispose: () => undefined, // no timers/network in local mode; keep the session
    destroy: () => session.destroy(),
  };
}
