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
      slotConfig: null,
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
  it('forces a registry slot config too, so a hybrid <Adaptive> version can be forced', async () => {
    // The scenario type declared `slotConfig` and applyScenario (RTL) honoured
    // it, but mockSentient dropped it. A forced arm id with no config resolves
    // nothing, so a Playwright test forcing `authored.social` on a hybrid
    // quietly asserted the original.
    let initFn: (a: unknown) => void = () => undefined;
    let initArg: unknown;
    const page = {
      addInitScript: async (fn: (a: unknown) => void, arg: unknown) => { initFn = fn; initArg = arg; },
      route: async () => {},
    };
    await mockSentient(page as never, {
      slots: { hero_cta: 'authored.social' },
      slotConfig: { hero_cta: { kind: 'arms' } },
    });
    expect(initArg).toMatchObject({ slotConfig: { hero_cta: { kind: 'arms' } } });

    const g = globalThis as unknown as { window?: Record<string, unknown> };
    const had = 'window' in g;
    const prev = g.window;
    g.window = {};
    try {
      initFn(initArg);
      expect(g.window.__sentient_slot_overrides).toEqual({ hero_cta: 'authored.social' });
      expect(g.window.__sentient_slot_config_overrides).toEqual({ hero_cta: { kind: 'arms' } });
    } finally {
      if (had) g.window = prev;
      else delete g.window;
    }
  });

  it('forwards slots/persona in init data and serves slots from /v1/decide', async () => {
    let initArg: unknown;
    let routeHandler: (r: FakeRoute) => unknown = () => undefined;
    const page = {
      addInitScript: async (_fn: (a: unknown) => void, arg: unknown) => { initArg = arg; },
      route: async (_p: string, handler: (r: FakeRoute) => unknown) => { routeHandler = handler; },
    };
    await mockSentient(page as never, {
      slots: { hero: { tone: 'urgent' } },
      persona: 'admin',
      confidence: 0.9,
    });
    expect(initArg).toMatchObject({ slots: { hero: { tone: 'urgent' } }, persona: 'admin', confidence: 0.9 });

    const decide = fakeRoute(
      'POST',
      'https://api.sentient-ui.com/v1/decide',
      JSON.stringify({ slots: [{ id: 'hero', dims: { tone: ['calm', 'urgent'] } }] }),
    );
    await routeHandler(decide.route);
    const body = JSON.parse(decide.calls.fulfill!.body!) as Record<string, unknown>;
    expect(body.slots).toEqual({ hero: { tone: 'urgent' } });
    expect(body.persona).toBe('admin');
  });
});
