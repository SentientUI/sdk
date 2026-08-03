import { resolveScenario } from './resolve.js';
import { getSentientEvents, type CapturedEvent } from './events.js';
import type { SentientScenario } from './scenario.js';

type InitData = {
  overrides: Record<string, string>;
  layout: string[] | null;
  slots: Record<string, string | Record<string, string>> | null;
  persona: string | null;
  confidence: number;
};

type PwRoute = {
  request(): { method(): string; url(): string; postData(): string | null };
  fulfill(r: { status: number; contentType?: string; body?: string }): Promise<void>;
  continue(): Promise<void>;
};

/** Structural subset of Playwright's `Page` — avoids a hard dependency on @playwright/test. */
type PwPage = {
  // Return types are intentionally `Promise<unknown>`: the helper never uses
  // them, and pinning `Promise<void>` breaks against Playwright versions whose
  // `addInitScript`/`route` resolve to `Disposable` rather than `void`.
  addInitScript(script: (arg: InitData) => void, arg: InitData): Promise<unknown>;
  route(url: string, handler: (route: PwRoute) => unknown): Promise<unknown>;
};

/**
 * Make a Playwright `page` serve a SentientUI scenario: forces
 * variants/layout/slots/persona before load (including the persona html
 * attributes) and stubs every `/v1/*` request from the scenario, capturing
 * posted events. Returns a handle exposing `.events()`.
 */
export async function mockSentient(
  page: PwPage,
  scenario: SentientScenario = {},
): Promise<{ events: () => CapturedEvent[] }> {
  const initData: InitData = {
    overrides: scenario.variants ?? {},
    layout: scenario.layout ?? null,
    slots: scenario.slots ?? null,
    persona: scenario.persona ?? null,
    confidence: scenario.confidence ?? 1,
  };
  await page.addInitScript((data: InitData) => {
    const w = window as unknown as Record<string, unknown>;
    w.__sentient_overrides = data.overrides;
    if (data.layout) w.__sentient_layout_override = data.layout;
    if (data.slots) w.__sentient_slot_overrides = data.slots;
    if (data.persona) {
      w.__sentient_persona_override = { persona: data.persona, confidence: data.confidence };
      try {
        // Inline banding: this function is SERIALIZED into the page context,
        // so it cannot close over imports. Cutoffs pinned to policy
        // confidenceBand (<0.3 low, <0.7 medium, else high).
        const band = data.confidence < 0.3 ? 'low' : data.confidence < 0.7 ? 'medium' : 'high';
        document.documentElement.setAttribute('data-sentient-persona', data.persona);
        document.documentElement.setAttribute('data-sentient-confidence', band);
      } catch {
        /* document not ready — the SDK adopts the override globals instead */
      }
    }
  }, initData);

  await page.route('**/v1/**', async (route) => {
    const req = route.request();
    const resolved = await resolveScenario(scenario, req.method(), req.url(), req.postData());
    if (!resolved) return route.continue();
    await route.fulfill({
      status: resolved.status,
      contentType: 'application/json',
      body: JSON.stringify(resolved.json ?? {}),
    });
  });

  return { events: () => getSentientEvents() };
}
