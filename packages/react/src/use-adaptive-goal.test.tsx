import { renderHook, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { useAdaptiveGoal } from './use-adaptive-goal.js';
import { init } from '@sentientui/core';

vi.mock('@sentientui/core', () => ({ init: vi.fn() }));
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn() }));
vi.mock('./segment.js', () => ({ detectSegment: () => 'desktop:direct' }));

const mockedInit = vi.mocked(init);

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getAssignment: vi.fn().mockReturnValue(null),
    assign: vi.fn().mockResolvedValue(null),
    destroy: vi.fn(),
    dispose: vi.fn(),
    track: vi.fn(),
    goal: vi.fn(),
    componentGoal: vi.fn(),
    identify: vi.fn(),
    getGraph: vi.fn().mockReturnValue({ pageNodes: [], capturedAt: 0 }),
    fetchWeights: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return createElement(AdaptiveProvider, {
      enableGraph: false,
    apiKey: 'pk_test_key_1234',
    context: 'saas',
    consent: true,
    children,
  });
}

describe('useAdaptiveGoal', () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    mockedInit.mockReturnValue(client as never);
  });

  it('delegates to client.componentGoal with the componentId and options', async () => {
    const { result } = renderHook(() => useAdaptiveGoal('hero_headline'), { wrapper });

    act(() => {
      result.current('hero_contact', { metadata: { method: 'whatsapp' } });
    });

    expect(client.componentGoal).toHaveBeenCalledTimes(1);
    expect(client.componentGoal).toHaveBeenCalledWith('hero_headline', 'hero_contact', {
      metadata: { method: 'whatsapp' },
    });
    // Also writes the session goal-funnel record (matching <Adaptive>), so a
    // manual conversion appears in the funnel, not just per-variant CVR.
    expect(client.goal).toHaveBeenCalledWith('hero_contact', { method: 'whatsapp' }, 1.0, 0);
  });

  it('records at most once per goal type when `once` is set', () => {
    const { result } = renderHook(() => useAdaptiveGoal('checkout'), { wrapper });

    act(() => {
      result.current('reached_step_3', { once: true });
      result.current('reached_step_3', { once: true });
      result.current('reached_step_3', { once: true });
    });

    expect(client.componentGoal).toHaveBeenCalledTimes(1);
    expect(client.goal).toHaveBeenCalledTimes(1);
  });

  it('latches per goal type, not per component', () => {
    const { result } = renderHook(() => useAdaptiveGoal('checkout'), { wrapper });

    act(() => {
      result.current('reached_step_3', { once: true });
      result.current('reached_step_4', { once: true });
    });

    expect(client.componentGoal).toHaveBeenCalledTimes(2);
  });

  it('still records every call without `once` — a repeat action is a repeat conversion', () => {
    const { result } = renderHook(() => useAdaptiveGoal('cart'), { wrapper });

    act(() => {
      result.current('add_to_cart');
      result.current('add_to_cart');
    });

    expect(client.componentGoal).toHaveBeenCalledTimes(2);
  });

  it('passes through undefined options when called with just a goal type', () => {
    const { result } = renderHook(() => useAdaptiveGoal('pricing'), { wrapper });

    act(() => {
      result.current('subscribe');
    });

    expect(client.componentGoal).toHaveBeenCalledWith('pricing', 'subscribe', undefined);
    expect(client.goal).toHaveBeenCalledWith('subscribe', {}, 1.0, 0);
  });
});

describe('useAdaptiveGoal â€” dev override suppresses tracking (#1)', () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    mockedInit.mockReturnValue(client as never);
  });

  afterEach(() => {
    delete window.__sentient_overrides;
  });

  it('fires NEITHER componentGoal NOR goal while the component is force-overridden', () => {
    // A forced variant (?sentient_variant= / __sentient_overrides) is a dev/QA
    // preview. Firing a manual goal would credit the bandit + pollute the funnel
    // for the overridden arm, breaking the "no events recorded, weights
    // unchanged" contract the other surfaces honor.
    window.__sentient_overrides = { hero: 'variant-b' };
    const { result } = renderHook(() => useAdaptiveGoal('hero'), { wrapper });

    act(() => {
      result.current('signup', { metadata: { plan: 'pro' } });
    });

    expect(client.componentGoal).not.toHaveBeenCalled();
    expect(client.goal).not.toHaveBeenCalled();
  });

  it('still fires normally for a component that is NOT overridden', () => {
    // An override on a different component must not suppress this one.
    window.__sentient_overrides = { other: 'variant-x' };
    const { result } = renderHook(() => useAdaptiveGoal('hero'), { wrapper });

    act(() => {
      result.current('signup');
    });

    expect(client.componentGoal).toHaveBeenCalledWith('hero', 'signup', undefined);
    expect(client.goal).toHaveBeenCalledWith('signup', {}, 1.0, 0);
  });
});
