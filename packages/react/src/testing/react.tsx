// RTL-dependent helper behind its own subpath (`@sentientui/react/testing/react`):
// @testing-library/react is an OPTIONAL peer, so importing it at the top of the
// main /testing entry crashed any consumer without it installed the moment they
// imported ANY testing helper — same split as /testing/node (msw/node) and
// /testing/msw (msw).
import type { ReactElement } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { AdaptiveProvider } from '../provider.js';
import { applyScenario, type SentientScenario } from './scenario.js';

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
