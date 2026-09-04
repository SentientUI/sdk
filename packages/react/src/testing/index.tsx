import { applyScenario, resetScenario, type SentientScenario } from './scenario.js';

export type { SentientScenario };
export { applyScenario, resetScenario };
// NOT re-exported here: `scenarioToHandlers` (msw) lives at
// `@sentientui/react/testing/msw`, and `renderWithSentient`
// (@testing-library/react) at `@sentientui/react/testing/react`. Both are
// OPTIONAL peers, and their former top-level imports from this entry crashed
// any consumer without them installed the moment they imported ANY testing
// helper — the same reason msw/node already lives at `/testing/node`.
export { resolveScenario, type ResolvedResponse } from './resolve.js';
export { getSentientEvents, clearSentientEvents, hasFiredGoal, type CapturedEvent } from './events.js';
export type { ScenarioWeight, ScenarioApiOverride } from './scenario.js';
export { mockSentient } from './playwright.js';
export { mockSentientCypress } from './cypress.js';

/** Call in a test setup file to reset forced state after each test. */
export function setupSentientTests(): void {
  const g = globalThis as unknown as { afterEach?: (fn: () => void) => void };
  g.afterEach?.(() => resetScenario());
}
