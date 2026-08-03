import { http, HttpResponse } from 'msw';
import type { RequestHandler } from 'msw';
import { resolveScenario } from './resolve.js';
import type { SentientScenario } from './scenario.js';

/** Turn a scenario into MSW handlers stubbing every SDK endpoint + capturing events. */
export function scenarioToHandlers(scenario: SentientScenario = {}): RequestHandler[] {
  return [
    http.all('*/v1/*', async ({ request }) => {
      const bodyText =
        request.method === 'GET' || request.method === 'HEAD' ? null : await request.text();
      const r = await resolveScenario(scenario, request.method, request.url, bodyText);
      if (!r) return undefined; // not a stubbed route — let MSW handle passthrough
      if (r.json === undefined) return new HttpResponse(null, { status: r.status });
      return HttpResponse.json(r.json as object, { status: r.status });
    }),
  ];
}
