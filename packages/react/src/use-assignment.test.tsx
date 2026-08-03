import { renderHook, render, waitFor, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { useAssignment } from './use-assignment.js';
import { notifyOverridesChanged } from './override-events.js';
import { _resetWeightsStore, update as updateWeights, type ComponentWeights } from './weights-store.js';
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
    decide: vi.fn().mockResolvedValue(null),
    getSlotResult: vi.fn().mockReturnValue(null),
    getPersona: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

function staticWrapper(opts: {
  consent?: boolean;
  initialAssignments?: Record<string, string>;
  ssrFallback?: 'first' | 'none';
  onAssignment?: (componentId: string, variantId: string) => void;
  debug?: boolean;
}) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(AdaptiveProvider, {
      enableGraph: false,
      apiKey: 'pk_test_key_1234',
      context: 'saas',
      consent: opts.consent,
      initialAssignments: opts.initialAssignments,
      ssrFallback: opts.ssrFallback,
      onAssignment: opts.onAssignment,
      debug: opts.debug,
      children,
    });
  };
}

function cw(componentId: string, variants: ComponentWeights['variants']): ComponentWeights {
  return { componentId, updatedAt: 1, variants };
}

function setSearch(search: string): void {
  // jsdom allows replacing the URL via history; keep origin stable.
  window.history.replaceState({}, '', `/${search}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetWeightsStore();
  setSearch('');
  delete window.__sentient_overrides;
});

describe('useAssignment â€” SSR / no-client path', () => {
  it('returns preloaded variant from initialAssignments when client is absent', () => {
    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      {
        wrapper: staticWrapper({
          consent: false,
          initialAssignments: { hero: 'variant-a' },
        }),
      },
    );
    // A server-decided preload is settled — exposure is allowed to fire.
    expect(result.current).toEqual({ variantId: 'variant-a', content: null, isLoading: false, settled: true });
  });

  it('falls back to first variant for SEO when no client and no preloaded assignments', () => {
    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: false }) },
    );
    // SEO placeholder, not a real decision yet → unsettled (no phantom exposure).
    expect(result.current).toEqual({ variantId: 'variant-a', content: null, isLoading: false, settled: false });
  });

  it('returns empty slot when ssrFallback=none and no preloaded assignments', () => {
    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: false, ssrFallback: 'none' }) },
    );
    expect(result.current).toEqual({ variantId: null, content: null, isLoading: true, settled: false });
  });

  it('ignores invalid preloaded variant and falls back to first for SEO', () => {
    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      {
        wrapper: staticWrapper({
          consent: false,
          initialAssignments: { hero: 'variant-z' }, // not in list
        }),
      },
    );
    expect(result.current).toEqual({ variantId: 'variant-a', content: null, isLoading: false, settled: false });
  });
});

describe('useAssignment â€” with live client', () => {
  it('uses cached assignment immediately and does not call assign', async () => {
    const assignment = {
      variantId: 'variant-a',
      assignedAt: Date.now(),
      segment: 'desktop:direct',
      confidence: 0.9,
    };
    const client = makeClient({ getAssignment: vi.fn().mockReturnValue(assignment) });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true }) },
    );

    await waitFor(() => expect(result.current.variantId).toBe('variant-a'));
    expect(client.assign).not.toHaveBeenCalled();
  });

  it('falls back to variantIds[0] then fetches from server and updates', async () => {
    const client = makeClient({
      getAssignment: vi.fn().mockReturnValue(null),
      assign: vi.fn().mockResolvedValue({ variantId: 'variant-b' }),
    });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true }) },
    );

    await waitFor(() => expect(result.current.variantId).toBe('variant-b'));
    expect(client.assign).toHaveBeenCalledWith('hero', ['variant-a', 'variant-b'], undefined, undefined);
  });

  it('calls onAssignment once when variant is resolved', async () => {
    const onAssignment = vi.fn();
    const client = makeClient({
      getAssignment: vi.fn().mockReturnValue(null),
      assign: vi.fn().mockResolvedValue({ variantId: 'variant-b' }),
    });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true, onAssignment }) },
    );

    await waitFor(() => expect(result.current.variantId).toBe('variant-b'));
    expect(onAssignment).toHaveBeenCalledOnce();
    expect(onAssignment).toHaveBeenCalledWith('hero', 'variant-b');
  });

  it('does not call onAssignment a second time on re-render with same variant', async () => {
    const onAssignment = vi.fn();
    const assignment = { variantId: 'variant-a', assignedAt: Date.now(), segment: 'desktop:direct', confidence: 1 };
    const client = makeClient({ getAssignment: vi.fn().mockReturnValue(assignment) });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { result, rerender } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true, onAssignment }) },
    );

    await waitFor(() => expect(result.current.variantId).toBe('variant-a'));
    rerender();
    expect(onAssignment).toHaveBeenCalledOnce();
  });

  it('keeps fallback when server returns null', async () => {
    const client = makeClient({
      getAssignment: vi.fn().mockReturnValue(null),
      assign: vi.fn().mockResolvedValue(null),
    });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true }) },
    );

    // After client initialises the fallback is variantIds[0].
    await waitFor(() => expect(result.current.variantId).toBe('variant-a'));
  });
});

describe('useAssignment â€” pickFromWeights via weights store', () => {
  it('picks the highest avgReward variant when a weights update arrives and there is no cached assignment', async () => {
    // Live client, no cached assignment, assign never resolves a variant.
    const client = makeClient({ getAssignment: vi.fn().mockReturnValue(null) });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true }) },
    );

    // Once the client is live the fallback is variantIds[0].
    await waitFor(() => expect(result.current.variantId).toBe('variant-a'));

    // A weights update (subscribe path) selects the best variant via pickFromWeights.
    act(() => {
      updateWeights(
        'hero',
        cw('hero', [
          { variantId: 'variant-a', pulls: 5, avgReward: 0.2 },
          { variantId: 'variant-b', pulls: 5, avgReward: 0.9 },
        ]),
      );
    });

    expect(result.current.variantId).toBe('variant-b');
  });

  it('on an avgReward tie, selects the first matching variant in weights order (strict > comparison)', async () => {
    const client = makeClient({ getAssignment: vi.fn().mockReturnValue(null) });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true }) },
    );

    await waitFor(() => expect(result.current.variantId).toBe('variant-a'));

    act(() => {
      updateWeights(
        'hero',
        cw('hero', [
          { variantId: 'variant-b', pulls: 5, avgReward: 0.5 },
          { variantId: 'variant-a', pulls: 5, avgReward: 0.5 },
        ]),
      );
    });

    // First entry (variant-b) wins because the loop only replaces on strictly greater.
    expect(result.current.variantId).toBe('variant-b');
  });

  it('keeps the existing variant when a weights update has no overlap with variantIds (pickFromWeights -> null)', async () => {
    const client = makeClient({ getAssignment: vi.fn().mockReturnValue(null) });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true }) },
    );

    await waitFor(() => expect(result.current.variantId).toBe('variant-a'));

    act(() => {
      updateWeights('hero', cw('hero', [{ variantId: 'unknown-x', pulls: 5, avgReward: 0.99 }]));
    });

    // No overlap -> pickFromWeights returns null -> state is left untouched.
    expect(result.current.variantId).toBe('variant-a');
  });
});

describe('useAssignment â€” dev override (sentient_variant URL param)', () => {
  it('applies a valid override and short-circuits the bandit', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);
    setSearch('?sentient_variant=hero:variant-b');

    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true, debug: true }) },
    );

    expect(result.current).toEqual({ variantId: 'variant-b', content: null, isLoading: false, settled: true, isOverride: true });
    // The diagnostic log now fires from an effect, gated behind the provider's debug flag.
    await waitFor(() => expect(infoSpy).toHaveBeenCalled());
    // Override short-circuits assign entirely.
    expect(client.assign).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  it('ignores a malformed override with no colon separator', () => {
    const client = makeClient({ getAssignment: vi.fn().mockReturnValue(null) });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);
    setSearch('?sentient_variant=heroVariantB'); // no ':' -> skipped

    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true }) },
    );

    // No override -> normal first-variant fallback.
    expect(result.current.variantId).toBe('variant-a');
  });

  it('ignores an override whose variant is not in variantIds', () => {
    const client = makeClient({ getAssignment: vi.fn().mockReturnValue(null) });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);
    setSearch('?sentient_variant=hero:variant-z'); // not in list

    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true }) },
    );

    expect(result.current.variantId).toBe('variant-a');
  });

  it('ignores an override targeting a different componentId', () => {
    const client = makeClient({ getAssignment: vi.fn().mockReturnValue(null) });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);
    setSearch('?sentient_variant=other:variant-b');

    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true }) },
    );

    expect(result.current.variantId).toBe('variant-a');
  });

  it('re-renders to the override variant when the devtools sets it after mount and notifies', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true }) },
    );

    await waitFor(() => expect(result.current.variantId).toBe('variant-a'));

    // Devtools writes the correct channel + notifies on an already-mounted hook.
    act(() => {
      window.__sentient_overrides = { hero: 'variant-b' };
      notifyOverridesChanged();
    });

    expect(result.current.variantId).toBe('variant-b');
    infoSpy.mockRestore();
  });

  it('honors window.__sentient_overrides ahead of the URL param', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    window.__sentient_overrides = { hero: 'variant-b' };
    setSearch('?sentient_variant=hero:variant-a');

    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true }) },
    );

    expect(result.current.variantId).toBe('variant-b');
    infoSpy.mockRestore();
  });
});

describe('useAssignment â€” override hydration safety (#3)', () => {
  it('SSR renders the un-forced variant; hydration applies the override with no mismatch', async () => {
    // The override is read via useSyncExternalStore with a null server snapshot,
    // so the server HTML is un-forced and the hydration render matches it (no
    // mismatch); React then re-renders with the client snapshot and applies the
    // forced variant.
    function Probe() {
      const { variantId } = useAssignment('hero', ['variant-a', 'variant-b']);
      return createElement('span', null, variantId);
    }
    const tree = createElement(
      staticWrapper({ consent: false, ssrFallback: 'first' }),
      null,
      createElement(Probe),
    );

    const html = renderToString(tree);
    expect(html).toContain('variant-a'); // server: override not applied

    window.__sentient_overrides = { hero: 'variant-b' };
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(tree, { container, hydrate: true });
    expect(errSpy).not.toHaveBeenCalled(); // no hydration mismatch
    await waitFor(() => expect(container.textContent).toBe('variant-b'));
    errSpy.mockRestore();
    container.remove();
  });

  it('applies a client-side override synchronously on a plain (non-hydration) mount, with no assign (R1)', () => {
    // On a client-only mount there is no server HTML to reconcile, so the forced
    // variant is correct on the very first render — no interim flip, so no stray
    // assign()/exposure can slip through before the override applies.
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);
    window.__sentient_overrides = { hero: 'variant-b' };
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true }) },
    );

    expect(result.current.variantId).toBe('variant-b');
    expect(result.current.isOverride).toBe(true);
    expect(client.assign).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });
});

describe('useAssignment â€” pickFromWeights incorporates pulls (#4)', () => {
  it('keeps a well-sampled arm over a lucky single-pull arm in the degraded weights fallback', async () => {
    const client = makeClient({ getAssignment: vi.fn().mockReturnValue(null) });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { result } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true }) },
    );

    await waitFor(() => expect(result.current.variantId).toBe('variant-a'));

    act(() => {
      updateWeights(
        'hero',
        cw('hero', [
          { variantId: 'variant-a', pulls: 500, avgReward: 0.2 },
          { variantId: 'variant-b', pulls: 1, avgReward: 1.0 },
        ]),
      );
    });

    // Greedy "highest avgReward" would pick variant-b (1.0); shrinkage toward a
    // zero prior sinks the 1-pull arm so the well-sampled variant-a wins.
    expect(result.current.variantId).toBe('variant-a');
  });
});

describe('useAssignment â€” unmount cancellation', () => {
  it('does not update state (no act warning) when assign resolves after unmount', async () => {
    let resolveAssign: ((v: { variantId: string } | null) => void) | undefined;
    const assign = vi.fn(
      () =>
        new Promise<{ variantId: string } | null>((res) => {
          resolveAssign = res;
        }),
    );
    const client = makeClient({
      getAssignment: vi.fn().mockReturnValue(null),
      assign,
    });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { result, unmount } = renderHook(
      () => useAssignment('hero', ['variant-a', 'variant-b']),
      { wrapper: staticWrapper({ consent: true }) },
    );

    await waitFor(() => expect(assign).toHaveBeenCalled());
    // Fallback is variant-a while assign is in-flight.
    expect(result.current.variantId).toBe('variant-a');

    unmount();
    // Resolve after unmount: the cancelled flag must suppress the setState.
    resolveAssign?.({ variantId: 'variant-b' });
    await Promise.resolve();
    await Promise.resolve();

    // React would log an act()/"state update on unmounted component" error if
    // the cancelled guard were missing.
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
