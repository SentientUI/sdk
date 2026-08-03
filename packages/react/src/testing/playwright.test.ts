import { describe, expect, it, beforeEach } from 'vitest';
import { mockSentient } from './playwright';
import { clearSentientEvents } from './events';

type FakeRoute = {
  request(): { method(): string; url(): string; postData(): string | null };
  fulfill(r: { status: number; contentType?: string; body?: string }): Promise<void>;
  continue(): Promise<void>;
};

function fakeRoute(method: string, url: string, postData: string | null) {
  const calls: { fulfill?: { status: number; body?: string }; continued?: boolean } = {};
  const route: FakeRoute = {
    request: () => ({ method: () => method, url: () => url, postData: () => postData }),
    fulfill: async (r) => { calls.fulfill = r; },
    continue: async () => { calls.continued = true; },
  };
  return { route, calls };
}

describe('mockSentient (playwright)', () => {
  beforeEach(() => clearSentientEvents());

  it('sets init overrides and fulfils /v1 requests from the scenario', async () => {
    let initArg: unknown;
    let routeHandler: (r: FakeRoute) => unknown = () => undefined;
    const page = {
      addInitScript: async (_fn: (a: unknown) => void, arg: unknown) => { initArg = arg; },
      route: async (_pattern: string, handler: (r: FakeRoute) => unknown) => { routeHandler = handler; },
    };

    const handle = await mockSentient(page as never, { variants: { hero: 'b' }, layout: ['pricing', 'hero'] });
    expect(initArg).toEqual({
      overrides: { hero: 'b' },
      layout: ['pricing', 'hero'],
      slots: null,
      persona: null,
      confidence: 1,
    });

    const decide = fakeRoute('POST', 'https://api.sentient-ui.com/v1/decide', JSON.stringify({ sections: [{ id: 'hero' }, { id: 'pricing' }] }));
    await routeHandler(decide.route);
    expect(decide.calls.fulfill!.status).toBe(200);
    expect(JSON.parse(decide.calls.fulfill!.body!).layoutOrder).toEqual(['pricing', 'hero']);

    const ev = fakeRoute('POST', 'https://api.sentient-ui.com/v1/events', JSON.stringify([{ eventType: 'goal_achieved', goalType: 'signup' }]));
    await routeHandler(ev.route);
    expect(handle.events().some((e) => e.goalType === 'signup')).toBe(true);
  });

  it('passes non-/v1 requests through via route.continue', async () => {
    let routeHandler: (r: FakeRoute) => unknown = () => undefined;
    const page = {
      addInitScript: async () => {},
      route: async (_p: string, handler: (r: FakeRoute) => unknown) => { routeHandler = handler; },
    };
    await mockSentient(page as never, {});
    const other = fakeRoute('GET', 'https://api.sentient-ui.com/other', null);
    await routeHandler(other.route);
    expect(other.calls.continued).toBe(true);
  });
});

describe('mockSentient — slots + persona (adaptive ladder)', () => {
  it('forwards slots/persona in init data and serves slots from /v1/decide', async () => {
    let initArg: unknown;
    let routeHandler: (r: FakeRoute) => unknown = () => undefined;
    const page = {
      addInitScript: async (_fn: (a: unknown) => void, arg: unknown) => { initArg = arg; },
      route: async (_p: string, handler: (r: FakeRoute) => unknown) => { routeHandler = handler; },
    };
    await mockSentient(page as never, {
      slots: { hero: { tone: 'urgent' } },
      persona: 'buyer',
      confidence: 0.9,
    });
    expect(initArg).toMatchObject({ slots: { hero: { tone: 'urgent' } }, persona: 'buyer', confidence: 0.9 });

    const decide = fakeRoute(
      'POST',
      'https://api.sentient-ui.com/v1/decide',
      JSON.stringify({ slots: [{ id: 'hero', dims: { tone: ['calm', 'urgent'] } }] }),
    );
    await routeHandler(decide.route);
    const body = JSON.parse(decide.calls.fulfill!.body!) as Record<string, unknown>;
    expect(body.slots).toEqual({ hero: { tone: 'urgent' } });
    expect(body.persona).toBe('buyer');
  });
});
