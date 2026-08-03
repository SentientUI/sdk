import { describe, expect, it, afterAll } from 'vitest';
import { setupSentientServer } from './server';
import { getSentientEvents, clearSentientEvents } from './events';

const BASE = 'https://api.sentient-ui.com';

describe('setupSentientServer', () => {
  const s = setupSentientServer();
  afterAll(() => s.server.close());

  it('serves a scenario decide response and captures events', async () => {
    clearSentientEvents();
    s.use({ layout: ['a', 'b'] });
    const decide = await fetch(`${BASE}/v1/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', sections: [{ id: 'a' }, { id: 'b' }] }),
    });
    expect((await decide.json()).layoutOrder).toEqual(['a', 'b']);

    await fetch(`${BASE}/v1/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ eventType: 'goal_achieved', goalType: 'signup' }]),
    });
    expect(getSentientEvents().some((e) => e.goalType === 'signup')).toBe(true);
  });
});
