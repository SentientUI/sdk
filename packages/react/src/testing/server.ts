import { setupServer, type SetupServer } from 'msw/node';
import { scenarioToHandlers } from './handlers.js';
import type { SentientScenario } from './scenario.js';

/**
 * Create and start an msw/node server pre-loaded with the default (control)
 * scenario. Call `use(scenario)` to swap in a scenario for the current test.
 * Remember to `server.close()` in afterAll and `server.resetHandlers()` between tests.
 */
export function setupSentientServer(): {
  server: SetupServer;
  use: (scenario?: SentientScenario) => void;
} {
  const server = setupServer(...scenarioToHandlers());
  server.listen({ onUnhandledRequest: 'bypass' });
  return {
    server,
    use: (scenario: SentientScenario = {}) => server.use(...scenarioToHandlers(scenario)),
  };
}
