import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { scenarioToHandlers } from './handlers';
import { getSentientEvents, clearSentientEvents } from './events';

const BASE = 'https://api.sentient-ui.com';

describe('scenarioToHandlers', () => {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => { server.resetHandlers(); clearSentientEvents(); });
  afterAll(() => server.close());

  it('serves forced layout, assignments, and persona from /v1/decide', async () => {
    server.use(...scenarioToHandlers({ layout: ['pricing', 'hero'], variants: { hero: 'b' }, persona: 'buyers' }));
    const res = await fetch(`${BASE}/v1/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', sections: [{ id: 'hero' }, { id: 'pricing' }], components: [] }),
    });
    const body = await res.json();
    expect(body.layoutOrder).toEqual(['pricing', 'hero']);
    expect(body.assignments).toEqual({ hero: 'b' });
    expect(body.persona).toBe('buyers');
  });

  it('captures posted events from /v1/events', async () => {
    server.use(...scenarioToHandlers());
    const res = await fetch(`${BASE}/v1/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ eventType: 'goal_achieved', goalType: 'signup', componentId: 'hero' }]),
    });
    expect(res.status).toBe(204);
    expect(getSentientEvents()).toHaveLength(1);
    expect(getSentientEvents()[0]!.goalType).toBe('signup');
  });

  it('injects an API error when scenario.api requests it', async () => {
    server.use(...scenarioToHandlers({ api: { '/v1/assign': 'error' } }));
    const res = await fetch(`${BASE}/v1/assign`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', componentId: 'hero', variantIds: ['control', 'b'] }),
    });
    expect(res.status).toBe(500);
  });
});
