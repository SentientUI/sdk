// msw-dependent helper behind its own subpath (`@sentientui/react/testing/msw`):
// msw is an OPTIONAL peer, so handlers.ts's top-level `import { http } from
// 'msw'` re-exported from the main /testing entry crashed any consumer without
// msw installed the moment they imported ANY testing helper (applyScenario,
// the Playwright/Cypress mocks, …) — the same reason msw/node already lives at
// `/testing/node` instead of the main entry.
export { scenarioToHandlers } from './handlers.js';
