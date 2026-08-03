import { recordEvent, type CapturedEvent } from './events.js';
import { confidenceBandOf, type SentientScenario, type ScenarioApiOverride } from './scenario.js';

/** A framework-agnostic resolved response. `json` undefined ⇒ empty body. */
export type ResolvedResponse = { status: number; json?: unknown };

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url.split('?')[0] ?? url; }
}

async function apiOverride(scenario: SentientScenario, route: string): Promise<ResolvedResponse | null> {
  const o: ScenarioApiOverride | undefined = scenario.api?.[route];
  if (o === undefined) return null;
  if (o === 'error') return { status: 500 };
  if (typeof o === 'number') return { status: o };
  if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
  return { status: o.status ?? 200, json: o.body ?? {} };
}

/**
 * Resolve a request against a scenario. Returns a response, or null for routes
 * outside `/v1/*` (let the caller pass through). Shared by the MSW handlers and
 * the Playwright/Cypress adapters so behaviour can't drift.
 */
export async function resolveScenario(
  scenario: SentientScenario,
  _method: string,
  url: string,
  bodyText: string | null,
): Promise<ResolvedResponse | null> {
  const path = pathOf(url);
  if (!path.includes('/v1/')) return null;

  const route = '/v1/' + (path.split('/v1/')[1] ?? '');
  const override = await apiOverride(scenario, route);
  if (override) return override;

  const body = bodyText ? (JSON.parse(bodyText) as unknown) : {};

  if (route === '/v1/sessions') return { status: 204 };

  if (route === '/v1/events') {
    for (const e of body as CapturedEvent[]) recordEvent(e);
    return { status: 204 };
  }

  if (route === '/v1/goals') {
    recordEvent({ eventType: 'goal', goalType: (body as { name?: string }).name });
    return { status: 204 };
  }

  if (route === '/v1/assign') {
    const b = body as { componentId: string; variantIds?: string[] };
    const variantId = scenario.variants?.[b.componentId] ?? b.variantIds?.[0] ?? 'control';
    return { status: 200, json: { variantId, assignmentTtlMs: 60_000 } };
  }

  if (route === '/v1/decide') {
    const b = body as {
      sections?: { id: string }[];
      slots?: Array<{
        id: string;
        arms?: string[];
        dims?: Record<string, string[]>;
        baseline?: string | Record<string, string>;
      }>;
    };
    const layoutOrder = scenario.layout ?? (b.sections ?? []).map((s) => s.id);
    const json: Record<string, unknown> = {
      layoutOrder,
      assignments: scenario.variants ?? {},
      persona: scenario.persona ?? 'unknown',
      confidence: scenario.confidence ?? 1,
    };
    // Mirror the real server: the slots key exists ONLY when slots were requested.
    if (b.slots && b.slots.length > 0) {
      const slots: Record<string, unknown> = {};
      for (const decl of b.slots) {
        slots[decl.id] = scenario.slots?.[decl.id] ?? defaultSlotResult(decl);
      }
      json.slots = slots;
    }
    return { status: 200, json };
  }

  if (route === '/v1/explain') {
    const b = body as {
      sections?: { id: string }[];
      persona?: string;
      slots?: Array<{
        id: string;
        arms?: string[];
        dims?: Record<string, string[]>;
        baseline?: string | Record<string, string>;
      }>;
    };
    const layoutOrder = scenario.layout ?? (b.sections ?? []).map((s) => s.id);
    const persona = b.persona ?? scenario.persona ?? 'unknown';
    const confidence = scenario.confidence ?? 1;
    const json: Record<string, unknown> = {
      layoutOrder,
      assignments: scenario.variants ?? {},
      persona,
      reasons: [],
      personaAttributes: { persona, confidence: confidenceBandOf(confidence) },
    };
    if (b.slots && b.slots.length > 0) {
      const slots: Record<string, unknown> = {};
      for (const decl of b.slots) {
        slots[decl.id] = scenario.slots?.[decl.id] ?? defaultSlotResult(decl);
      }
      json.slots = slots;
    }
    return { status: 200, json };
  }

  if (route === '/v1/weights') {
    const components = Object.entries(scenario.weights ?? {}).map(([componentId, variants]) => ({ componentId, updatedAt: 0, variants }));
    return { status: 200, json: { components } };
  }

  return null;
}

/** Declared baseline of a slot: explicit `baseline`, else first arm / first value per dim. */
function defaultSlotResult(decl: {
  arms?: string[];
  dims?: Record<string, string[]>;
  baseline?: string | Record<string, string>;
}): string | Record<string, string> {
  if (decl.arms) {
    return typeof decl.baseline === 'string' ? decl.baseline : decl.arms[0] ?? 'baseline';
  }
  const out: Record<string, string> = {};
  for (const [dim, values] of Object.entries(decl.dims ?? {})) {
    const declared =
      typeof decl.baseline === 'object' && decl.baseline !== null ? decl.baseline[dim] : undefined;
    out[dim] = declared ?? values[0] ?? '';
  }
  return out;
}
