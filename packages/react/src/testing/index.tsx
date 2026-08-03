import type { ReactElement } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { AdaptiveProvider } from '../provider.js';
import { applyScenario, resetScenario, type SentientScenario } from './scenario.js';

export type { SentientScenario };
export { applyScenario, resetScenario };
export { scenarioToHandlers } from './handlers.js';
export { resolveScenario, type ResolvedResponse } from './resolve.js';
export { getSentientEvents, clearSentientEvents, hasFiredGoal, type CapturedEvent } from './events.js';
export type { ScenarioWeight, ScenarioApiOverride } from './scenario.js';
export { mockSentient } from './playwright.js';
export { mockSentientCypress } from './cypress.js';

/**
 * Render `ui` under a SentientUI provider configured for tests: consent is off,
 * so the SDK never initialises a client and every <Adaptive> renders its control
 * variant with zero network. A scenario forces specific variants/layout.
 */
export function renderWithSentient(
  ui: ReactElement,
  scenario: SentientScenario = {},
  options?: RenderOptions,
): RenderResult {
  applyScenario(scenario);
  return render(
    <AdaptiveProvider apiKey="pk_test" context="saas" consent={false}>
      {ui}
    </AdaptiveProvider>,
    options,
  );
}

/** Call in a test setup file to reset forced state after each test. */
export function setupSentientTests(): void {
  const g = globalThis as unknown as { afterEach?: (fn: () => void) => void };
  g.afterEach?.(() => resetScenario());
}
