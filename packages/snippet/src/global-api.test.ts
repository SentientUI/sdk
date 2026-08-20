import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@sentientui/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentientui/core')>();
  return { ...actual, init: vi.fn() };
});
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn(() => () => undefined) }));
vi.mock('./slot-signals', () => ({ attachSlotSignals: vi.fn(() => vi.fn()) }));

declare global {
  interface Window { sentient?: unknown }
}

const CONFIG = {
  apiKey: 'pk_test',
  context: 'landing',
  slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } },
};

function makeClient() {
  return {
    goal: vi.fn(),
    componentGoal: vi.fn(),
    decide: vi.fn().mockResolvedValue({
      layoutOrder: null, assignments: {}, slots: { hero: { tone: 'calm' } }, persona: 'unknown', confidence: 0.1,
    }),
    getPersona: vi.fn().mockReturnValue(null),
    destroy: vi.fn(),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<section id="hero"></section>';
  delete (window as unknown as { SentientSnippet?: unknown }).SentientSnippet;
  (window as Window).sentient = CONFIG;
});

describe('SentientSnippet.goal revenue options (spec §5)', () => {
  it('forwards the options object to the core client verbatim', async () => {
    const client = makeClient();
    const mod = await import('./index');
    const { init } = await import('@sentientui/core');
    vi.mocked(init).mockReturnValue(client as never);

    await mod.run();

    const api = (window as unknown as { SentientSnippet: { goal: (n: string, o?: unknown) => void } }).SentientSnippet;
    api.goal('purchase', { value: 129.99, externalId: '1042' });
    expect(client.goal).toHaveBeenCalledWith('purchase', { value: 129.99, externalId: '1042' });
  });

  it('still supports the legacy metadata second argument', async () => {
    const client = makeClient();
    const mod = await import('./index');
    const { init } = await import('@sentientui/core');
    vi.mocked(init).mockReturnValue(client as never);

    await mod.run();

    const api = (window as unknown as { SentientSnippet: { goal: (n: string, o?: unknown) => void } }).SentientSnippet;
    api.goal('signup', { plan: 'pro' });
    expect(client.goal).toHaveBeenCalledWith('signup', { plan: 'pro' });
  });

  it('drains calls queued on a pre-boot stub', async () => {
    // The stub must exist BEFORE the module evaluates — module-scope capture is
    // the only moment the stub is visible (tsup's IIFE assignment replaces the
    // global right after the module body runs).
    (window as unknown as { SentientSnippet?: unknown }).SentientSnippet = {
      q: [['goal', 'purchase', { value: 50 }]],
      goal() { /* stub */ },
    };
    const client = makeClient();
    const mod = await import('./index');
    const { init } = await import('@sentientui/core');
    vi.mocked(init).mockReturnValue(client as never);

    await mod.run();

    expect(client.goal).toHaveBeenCalledWith('purchase', { value: 50 });
  });
});
