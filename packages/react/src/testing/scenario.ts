import { notifyOverridesChanged } from '../override-events.js';

export type ScenarioWeight = { variantId: string; pulls: number; avgReward: number };
export type ScenarioApiOverride =
  | 'error'
  | number
  | { status?: number; body?: unknown; delayMs?: number };

export type SentientScenario = {
  variants?: Record<string, string>;
  layout?: string[];
  /** Forced persona (canonical PersonaKey). Also sets the persona html attributes. */
  persona?: string;
  /** Persona confidence 0–1; buckets to low/medium/high for the html attribute. Default 1. */
  confidence?: number;
  /** Forced slot results: slot id → arm id (arms slots) or per-dim values (token slots). */
  slots?: Record<string, string | Record<string, string>>;
  weights?: Record<string, ScenarioWeight[]>;
  api?: Record<string, ScenarioApiOverride>;
};

type ScenarioWindow = {
  __sentient_overrides?: Record<string, string>;
  __sentient_layout_override?: string[];
  __sentient_slot_overrides?: Record<string, string | Record<string, string>>;
  __sentient_persona_override?: { persona: string; confidence?: number };
};

/**
 * Confidence → band. Cutoffs pinned to @sentientui/policy `confidenceBand`
 * (<0.3 low, <0.7 medium, else high). Duplicated (not imported) because the
 * Playwright init function is serialized into the page and cannot close
 * over imports — both copies are pinned by tests.
 */
export function confidenceBandOf(c: number): 'low' | 'medium' | 'high' {
  return c < 0.3 ? 'low' : c < 0.7 ? 'medium' : 'high';
}

/** Apply a scenario by setting the client-forcing globals the SDK reads. */
export function applyScenario(scenario: SentientScenario = {}): void {
  const w = window as unknown as ScenarioWindow;
  w.__sentient_overrides = { ...(scenario.variants ?? {}) };
  if (scenario.layout) w.__sentient_layout_override = scenario.layout;
  else delete w.__sentient_layout_override;
  if (scenario.slots) w.__sentient_slot_overrides = { ...scenario.slots };
  else delete w.__sentient_slot_overrides;
  if (scenario.persona) {
    w.__sentient_persona_override = {
      persona: scenario.persona,
      confidence: scenario.confidence ?? 1,
    };
    try {
      const d = document.documentElement;
      d.setAttribute('data-sentient-persona', scenario.persona);
      d.setAttribute('data-sentient-confidence', confidenceBandOf(scenario.confidence ?? 1));
    } catch {
      /* no DOM (node env) — the override globals still apply */
    }
  } else {
    delete w.__sentient_persona_override;
  }
  // Ring the override bus so hooks already mounted (useAssignment /
  // useSlotResult / useAdaptivePersona subscribe via useSyncExternalStore)
  // re-render immediately — otherwise forcing state mid-test only takes effect
  // on the next unrelated render.
  notifyOverridesChanged();
}

/** Clear all forced state. */
export function resetScenario(): void {
  const w = window as unknown as ScenarioWindow;
  delete w.__sentient_overrides;
  delete w.__sentient_layout_override;
  delete w.__sentient_slot_overrides;
  delete w.__sentient_persona_override;
  try {
    document.documentElement.removeAttribute('data-sentient-persona');
    document.documentElement.removeAttribute('data-sentient-confidence');
  } catch {
    /* no DOM */
  }
  notifyOverridesChanged();
}
