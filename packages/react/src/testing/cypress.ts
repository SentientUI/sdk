import { resolveScenario } from './resolve.js';
import { confidenceBandOf, type SentientScenario } from './scenario.js';

type CyReq = {
  method: string;
  url: string;
  body: unknown;
  reply(r: { statusCode: number; body?: unknown }): void;
};

/** Structural subset of Cypress's `cy` — avoids a hard dependency on cypress. */
type Cy = {
  intercept(url: string, handler: (req: CyReq) => void | Promise<void>): unknown;
  on(event: string, cb: (win: Record<string, unknown>) => void): unknown;
};

/**
 * Make Cypress serve a SentientUI scenario: forces variants/layout/slots/persona
 * on the app window before load (including the persona html attributes) and
 * stubs every `/v1/*` request from the scenario. Call in a `beforeEach` before
 * `cy.visit`.
 *
 * Note: for event assertions in Cypress, alias the intercept (`cy.intercept(...).as('ev')`)
 * and `cy.wait('@ev')` — captured module state does not cross the browser/Node boundary.
 */
export function mockSentientCypress(cy: Cy, scenario: SentientScenario = {}): void {
  const overrides = scenario.variants ?? {};
  const layout = scenario.layout ?? null;
  const slots = scenario.slots ?? null;
  const persona = scenario.persona ?? null;
  const confidence = scenario.confidence ?? 1;

  cy.on('window:before:load', (win) => {
    win.__sentient_overrides = overrides;
    if (layout) win.__sentient_layout_override = layout;
    if (slots) win.__sentient_slot_overrides = slots;
    if (persona) {
      win.__sentient_persona_override = { persona, confidence };
      try {
        const doc = (win as { document?: Document }).document;
        doc?.documentElement?.setAttribute('data-sentient-persona', persona);
        doc?.documentElement?.setAttribute('data-sentient-confidence', confidenceBandOf(confidence));
      } catch {
        /* document not ready — the SDK adopts the override globals instead */
      }
    }
  });

  cy.intercept('**/v1/**', async (req) => {
    const resolved = await resolveScenario(
      scenario,
      req.method,
      req.url,
      req.body != null ? JSON.stringify(req.body) : null,
    );
    if (!resolved) return; // passthrough
    req.reply({ statusCode: resolved.status, body: (resolved.json ?? '') as unknown });
  });
}
