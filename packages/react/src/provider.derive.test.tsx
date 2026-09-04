import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// This file exercises provider internals that depend on core's detection
// helper (deriveSessionSegment, via deriveDefaultSegment) and on fetchWeights
// polling. It uses its own module mock so deriveSessionSegment can be made to
// throw, which the shared provider.test.tsx mock (init-only) cannot do.
const { init, deriveSessionSegment } = vi.hoisted(() => ({
  init: vi.fn(),
  deriveSessionSegment: vi.fn(() => 'desktop:direct'),
}));

vi.mock('@sentientui/core', () => ({
  init,
  deriveSessionSegment,
}));
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn() }));

import { AdaptiveProvider, useSentient, useSessionSegment } from './provider.js';

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

function wrapper(extra: Record<string, unknown> = {}) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(AdaptiveProvider, {
      apiKey: 'pk_test_key_1234',
      context: 'saas',
      consent: true,
      enableGraph: false,
      children,
      ...extra,
    });
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deriveSessionSegment.mockReturnValue('desktop:direct');
});

describe('deriveDefaultSegment', () => {
  it('uses the segment core derives when the helper succeeds', () => {
    deriveSessionSegment.mockReturnValue('mobile:paid');
    init.mockReturnValue(makeClient() as never);

    const { result } = renderHook(() => useSessionSegment(), { wrapper: wrapper() });
    expect(result.current).toBe('mobile:paid');
    // The provider must feed BROWSER globals to core's derivation — an empty
    // call would re-derive from nothing and diverge from init()'s cache key.
    expect(deriveSessionSegment).toHaveBeenCalledWith({
      userAgent: navigator.userAgent,
      referer: document.referrer,
      appOrigin: window.location.origin,
    });
  });

  it('falls back to desktop:direct when detection throws', () => {
    deriveSessionSegment.mockImplementation(() => {
      throw new Error('navigator exploded');
    });
    init.mockReturnValue(makeClient() as never);

    const { result } = renderHook(() => useSessionSegment(), { wrapper: wrapper() });
    expect(result.current).toBe('desktop:direct');
  });

  it('prefers an explicit sessionSegment prop over detection', () => {
    init.mockReturnValue(makeClient() as never);
    const { result } = renderHook(() => useSessionSegment(), {
      wrapper: wrapper({ sessionSegment: 'tablet:social' }),
    });
    expect(result.current).toBe('tablet:social');
    expect(deriveSessionSegment).not.toHaveBeenCalled();
  });
});

describe('weights polling', () => {
  it('keeps the client live and contains the rejection when fetchWeights rejects', async () => {
    // provider.tsx wraps the awaited `client.fetchWeights()` in a try/catch, so
    // a rejecting poll is swallowed (retried next interval) and never surfaces
    // as an unhandled promise rejection. The provider stays healthy.
    const captured: unknown[] = [];
    const onRej = (e: PromiseRejectionEvent): void => {
      captured.push(e.reason);
      e.preventDefault();
    };
    window.addEventListener('unhandledrejection', onRej);
    const nodeOnRej = (reason: unknown): void => { captured.push(reason); };
    process.on('unhandledRejection', nodeOnRej);

    try {
      const client = makeClient({
        fetchWeights: vi.fn().mockRejectedValue(new Error('network down')),
      });
      init.mockReturnValue(client as never);

      const { result } = renderHook(() => useSentient(), { wrapper: wrapper() });

      await waitFor(() => expect(result.current).not.toBeNull());
      await waitFor(() => expect(client.fetchWeights).toHaveBeenCalled());

      // Let the rejection propagate to the handler(s).
      await new Promise((r) => setTimeout(r, 0));

      // Provider remains healthy despite the rejected poll.
      expect(result.current).toBe(client);
      // The rejection was contained â€” no unhandled rejection escaped.
      expect(captured.some((r) => r instanceof Error && r.message === 'network down')).toBe(false);
    } finally {
      window.removeEventListener('unhandledrejection', onRej);
      process.off('unhandledRejection', nodeOnRej);
    }
  });

  it('runs the initial poll immediately and applies weights from fetchWeights', async () => {
    const client = makeClient({
      fetchWeights: vi.fn().mockResolvedValue([
        {
          componentId: 'hero',
          updatedAt: 5,
          variants: [{ variantId: 'a', pulls: 2, avgReward: 0.4 }],
        },
      ]),
    });
    init.mockReturnValue(client as never);

    renderHook(() => useSentient(), { wrapper: wrapper() });

    await waitFor(() => expect(client.fetchWeights).toHaveBeenCalled());
    const { getWeights } = await import('./weights-store.js');
    await waitFor(() => expect(getWeights('hero')?.updatedAt).toBe(5));
  });

  it('schedules repeat polls on the 60s interval', async () => {
    vi.useFakeTimers();
    try {
      const fetchWeights = vi.fn().mockResolvedValue([]);
      const client = makeClient({ fetchWeights });
      init.mockReturnValue(client as never);

      renderHook(() => useSentient(), { wrapper: wrapper() });

      // Flush the effect-scheduled microtasks for the initial poll.
      await vi.advanceTimersByTimeAsync(0);
      const afterInitial = fetchWeights.mock.calls.length;
      expect(afterInitial).toBeGreaterThanOrEqual(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchWeights.mock.calls.length).toBeGreaterThan(afterInitial);
    } finally {
      vi.useRealTimers();
    }
  });
});
