import { describe, expect, it, beforeEach } from 'vitest';
import { resolveScenario } from './resolve';
import { getSentientEvents, clearSentientEvents } from './events';

const BASE = 'https://api.sentient-ui.com';

describe('resolveScenario', () => {
  beforeEach(() => clearSentientEvents());

  it('returns null for non-/v1 routes (passthrough)', async () => {
    expect(await resolveScenario({}, 'GET', `${BASE}/other`, null)).toBeNull();
  });

  it('serves forced decide response', async () => {
    const r = await resolveScenario(
      { layout: ['pricing', 'hero'], variants: { hero: 'b' }, persona: 'buyers' },
      'POST', `${BASE}/v1/decide`, JSON.stringify({ sections: [{ id: 'hero' }, { id: 'pricing' }] }),
    );
    expect(r).toEqual({ status: 200, json: { layoutOrder: ['pricing', 'hero'], assignments: { hero: 'b' }, persona: 'buyers', confidence: 1 } });
  });

  it('captures events and returns 204', async () => {
    const r = await resolveScenario({}, 'POST', `${BASE}/v1/events`, JSON.stringify([{ eventType: 'goal_achieved', goalType: 'signup' }]));
    expect(r).toEqual({ status: 204 });
    expect(getSentientEvents()).toHaveLength(1);
  });

  it('applies an api error override', async () => {
    const r = await resolveScenario({ api: { '/v1/assign': 'error' } }, 'POST', `${BASE}/v1/assign?x=1`, JSON.stringify({ componentId: 'hero', variantIds: ['control'] }));
    expect(r).toEqual({ status: 500 });
  });
});
