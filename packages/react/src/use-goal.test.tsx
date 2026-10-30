import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The hook only reads the client and key from context; stand those in directly
// (useAdaptiveGoal reads the same module, so both see one client).
let current: { client: unknown; apiKey: string } = { client: null, apiKey: '' };
vi.mock('./provider.js', () => ({
  useSentient: () => current.client,
  useAdaptiveApiKey: () => current.apiKey,
}));

import { useGoal, __resetGoalDeclarations } from './use-goal.js';

function makeClient(over: Record<string, unknown> = {}) {
  return { track: vi.fn(), goal: vi.fn(), componentGoal: vi.fn(), ...over };
}

function provide(client: unknown, apiKey = 'pk_test') {
  current = { client, apiKey };
}

beforeEach(() => {
  __resetGoalDeclarations();
  vi.restoreAllMocks();
  current = { client: null, apiKey: '' };
});

describe('useGoal', () => {
  it('declares the goal on mount, so it shows at 0 before anyone completes it', () => {
    const client = makeClient();
    provide(client);
    renderHook(() => useGoal('viewed_pricing'));
    expect(client.track).toHaveBeenCalledWith({
      projectId: 'pk_test', componentId: '__session__', eventType: 'goal_declared', payload: { goalId: 'viewed_pricing' },
    });
    expect(client.goal).not.toHaveBeenCalled();
  });

  it('declares primary: true for the main goal', () => {
    const client = makeClient();
    provide(client);
    renderHook(() => useGoal('signup', { primary: true }));
    expect(client.track.mock.calls[0]![0]).toMatchObject({ payload: { goalId: 'signup', primary: true } });
  });

  it('declares once per page load, however many components hold the hook', () => {
    const client = makeClient();
    provide(client);
    renderHook(() => { useGoal('signup'); useGoal('signup'); });
    provide(client);
    renderHook(() => useGoal('signup'));
    expect(client.track).toHaveBeenCalledTimes(1);
  });

  it('keeps the first main goal when two hooks claim it, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = makeClient();
    provide(client);
    renderHook(() => { useGoal('signup', { primary: true }); useGoal('purchase', { primary: true }); });
    const payloads = client.track.mock.calls.map((c) => (c[0] as { payload: unknown }).payload);
    expect(payloads).toEqual([{ goalId: 'signup', primary: true }, { goalId: 'purchase' }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'signup' is already primary on this page"));
  });

  it('does not declare into a consent-gated client — the tracking client that replaces it does', () => {
    const client = makeClient({ gated: true });
    provide(client);
    renderHook(() => useGoal('signup', { primary: true }));
    expect(client.track).not.toHaveBeenCalled();
  });

  it('fires a session goal with the per-conversion options', () => {
    const client = makeClient();
    provide(client);
    const { result } = renderHook(() => useGoal('purchase'));
    result.current({ value: 42, externalId: 'o-1' });
    expect(client.goal).toHaveBeenCalledWith('purchase', { metadata: {}, weight: 1, stepIndex: 0, value: 42, externalId: 'o-1' });
    expect(client.componentGoal).not.toHaveBeenCalled();
  });

  it('records once with { once: true }', () => {
    const client = makeClient();
    provide(client);
    const { result } = renderHook(() => useGoal('reached_step_3'));
    result.current({ once: true });
    result.current({ once: true });
    expect(client.goal).toHaveBeenCalledTimes(1);
  });

  it('credits the served version too when given a componentId', () => {
    const client = makeClient();
    provide(client);
    const { result } = renderHook(() => useGoal('signup', { componentId: 'hero_cta' }));
    result.current();
    expect(client.componentGoal).toHaveBeenCalledWith('hero_cta', 'signup', undefined);
    expect(client.goal).toHaveBeenCalledWith('signup', expect.objectContaining({ weight: 1 }));
  });

  it('is a no-op without a provider', () => {
    const { result } = renderHook(() => useGoal('signup', { primary: true }));
    expect(() => result.current()).not.toThrow();
  });
});
