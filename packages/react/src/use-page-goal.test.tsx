import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { usePageGoal } from './use-page-goal.js';
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

/** Provider with a fixed consent state. Flip it mid-test in the gating case. */
function makeWrapper(consent: boolean) {
  return function wrapper({ children }: { children: ReactNode }) {
    return createElement(AdaptiveProvider, {
      enableGraph: false,
      apiKey: 'pk_test_key_1234',
      context: 'saas',
      consent,
      children,
    });
  };
}

describe('usePageGoal', () => {
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    client = makeClient();
    mockedInit.mockReturnValue(client as never);
  });

  it('records the arrival against the component that sent the visitor', () => {
    renderHook(() => usePageGoal('pricing_view', { componentId: 'hero_cta' }), {
      wrapper: makeWrapper(true),
    });

    expect(client.componentGoal).toHaveBeenCalledTimes(1);
    expect(client.componentGoal).toHaveBeenCalledWith('hero_cta', 'pricing_view', {});
    // Session-level record too, so the arrival shows in the goal funnel and not
    // only in per-variant CVR.
    expect(client.goal).toHaveBeenCalledWith('pricing_view', { metadata: {}, weight: 1.0, stepIndex: 0 });
  });

  it('records a session-level goal when there is no component to credit', () => {
    renderHook(() => usePageGoal('docs_view'), { wrapper: makeWrapper(true) });

    expect(client.componentGoal).not.toHaveBeenCalled();
    expect(client.goal).toHaveBeenCalledWith('docs_view', { metadata: {}, weight: 1.0, stepIndex: 0 });
  });

  it('forwards metadata and reward', () => {
    renderHook(() => usePageGoal('checkout_view', { metadata: { plan: 'growth' }, reward: 0.5 }), {
      wrapper: makeWrapper(true),
    });

    expect(client.goal).toHaveBeenCalledWith('checkout_view', { metadata: { plan: 'growth' }, weight: 0.5, stepIndex: 0 });
  });

  it('records the arrival once across re-renders', () => {
    const { rerender } = renderHook(() => usePageGoal('apply_view', { componentId: 'hero_cta' }), {
      wrapper: makeWrapper(true),
    });
    rerender();
    rerender();

    // useAdaptiveGoal has no latch of its own, so a second call here would be a
    // second conversion in the funnel for a single visit.
    expect(client.componentGoal).toHaveBeenCalledTimes(1);
    expect(client.goal).toHaveBeenCalledTimes(1);
  });

  it('holds the arrival until consent arrives instead of dropping it', () => {
    // A consent-gated site has no client when the page mounts. Firing on mount
    // and latching would lose the arrival for everyone who accepts a moment
    // later — which, behind a cookie banner, is nearly everyone.
    let consent = false;
    function wrapper({ children }: { children: ReactNode }) {
      return createElement(AdaptiveProvider, {
        enableGraph: false,
        apiKey: 'pk_test_key_1234',
        context: 'saas',
        consent,
        children,
      });
    }

    const { rerender } = renderHook(() => usePageGoal('apply_view', { componentId: 'hero_cta' }), {
      wrapper,
    });
    expect(client.componentGoal).not.toHaveBeenCalled();
    expect(client.goal).not.toHaveBeenCalled();

    // The visitor accepts: the provider starts the client, and the arrival that
    // was waiting is recorded — exactly once.
    consent = true;
    rerender();

    expect(client.componentGoal).toHaveBeenCalledTimes(1);
    expect(client.componentGoal).toHaveBeenCalledWith('hero_cta', 'apply_view', {});
    expect(client.goal).toHaveBeenCalledTimes(1);
  });

  it('records nothing while the component is force-overridden', () => {
    window.__sentient_overrides = { hero_cta: 'action' };
    renderHook(() => usePageGoal('apply_view', { componentId: 'hero_cta' }), {
      wrapper: makeWrapper(true),
    });

    // A forced variant is a dev/QA preview — inherited from useAdaptiveGoal.
    expect(client.componentGoal).not.toHaveBeenCalled();
    expect(client.goal).not.toHaveBeenCalled();
  });

  afterEach(() => {
    delete window.__sentient_overrides;
  });
});
