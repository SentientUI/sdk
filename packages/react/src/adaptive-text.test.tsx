import { render, waitFor, act } from '@testing-library/react';
import { createElement, useState, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { AdaptiveText } from './adaptive-text.js';
import { init } from '@sentientui/core';

vi.mock('@sentientui/core', () => ({
  init: vi.fn(),
  attachMicroSignalDetectors: vi.fn(() => () => undefined),
}));
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

function wrapper(onAssignment?: (id: string, variantId: string) => void) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(AdaptiveProvider, {
      enableGraph: false,
      apiKey: 'pk_test_key_1234',
      context: 'saas',
      consent: true,
      onAssignment,
      children,
    });
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AdaptiveText', () => {
  it('renders the default text when no managed content is assigned', async () => {
    mockedInit.mockReturnValue(makeClient() as never);
    const { getByText } = render(
      createElement(AdaptiveText, { id: 'headline', default: 'Ship faster' }),
      { wrapper: wrapper() },
    );
    expect(getByText('Ship faster')).toBeTruthy();
  });

  it('renders managed content returned by assign()', async () => {
    const client = makeClient({
      assign: vi.fn().mockResolvedValue({ variantId: 'bold', content: 'Convert more' }),
    });
    mockedInit.mockReturnValue(client as never);

    const { getByText, queryByText } = render(
      createElement(AdaptiveText, { id: 'headline', default: 'Ship faster' }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(getByText('Convert more')).toBeTruthy());
    expect(queryByText('Ship faster')).toBeNull();
  });

  it('tracks the impression and fires onAssignment once a variant resolves', async () => {
    const onAssignment = vi.fn();
    const client = makeClient({
      assign: vi.fn().mockResolvedValue({ variantId: 'bold', content: 'Convert more' }),
    });
    mockedInit.mockReturnValue(client as never);

    render(createElement(AdaptiveText, { id: 'headline', default: 'Ship faster' }), {
      wrapper: wrapper(onAssignment),
    });

    await waitFor(() => expect(onAssignment).toHaveBeenCalledWith('headline', 'bold'));
    expect(client.track).toHaveBeenCalledWith(
      expect.objectContaining({ componentId: 'headline', variantId: 'bold', eventType: 'variant_assigned' }),
    );
  });

  it('seeds cached managed content synchronously when the client is already live at mount (no flicker, no assign)', async () => {
    const assign = vi.fn().mockResolvedValue(null);
    const client = makeClient({
      assign,
      getAssignment: vi.fn().mockReturnValue({
        variantId: 'bold',
        assignedAt: Date.now(),
        segment: 'desktop:direct',
        confidence: 1,
        content: 'Cached headline',
      }),
    });
    mockedInit.mockReturnValue(client as never);

    // The provider initialises its client in a useEffect, so on the provider's
    // very first paint the client is null. AdaptiveText's synchronous useState
    // seed only sees a live client when it mounts *after* the provider is ready.
    // Harness: mount the provider first, then reveal AdaptiveText once a render
    // has flushed so its initialiser reads the live cached assignment.
    let reveal: (() => void) | undefined;
    function Harness({ children }: { children: ReactNode }) {
      const [show, setShow] = useState(false);
      reveal = () => setShow(true);
      return createElement(
        AdaptiveProvider,
        { apiKey: 'pk_test_key_1234', context: 'saas', consent: true, enableGraph: false, children: undefined } as never,
        show ? children : null,
      );
    }

    const { getByText, queryByText } = render(
      createElement(AdaptiveText, { id: 'headline', default: 'Ship faster' }),
      { wrapper: Harness },
    );

    // Provider effect runs -> client live. Now reveal AdaptiveText.
    await waitFor(() => expect(reveal).toBeTruthy());
    act(() => reveal!());

    // Cached content shows immediately on AdaptiveText's first paint; default never wins.
    expect(getByText('Cached headline')).toBeTruthy();
    expect(queryByText('Ship faster')).toBeNull();
    // content !== undefined -> assign() is skipped entirely.
    expect(assign).not.toHaveBeenCalled();
  });

  it('falls back to default and calls assign when the cached assignment has content=undefined', async () => {
    const assign = vi.fn().mockResolvedValue(null);
    const client = makeClient({
      assign,
      // Assignment exists but no managed content -> content === undefined.
      getAssignment: vi.fn().mockReturnValue({
        variantId: 'control',
        assignedAt: Date.now(),
        segment: 'desktop:direct',
        confidence: 1,
      }),
    });
    mockedInit.mockReturnValue(client as never);

    const { getByText } = render(
      createElement(AdaptiveText, { id: 'headline', default: 'Ship faster' }),
      { wrapper: wrapper() },
    );

    // No cached content -> renders the default while assign runs.
    expect(getByText('Ship faster')).toBeTruthy();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('headline'));
  });

  it('honors a dev override — suppresses assign, exposure, and goals (parity with <Adaptive>)', async () => {
    // Same setup as the assign()-is-called test above, but with a forced
    // override: getAssignment returns null (would normally trigger assign()).
    window.__sentient_overrides = { headline: 'forced' };
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);

    const { getByText } = render(
      createElement(AdaptiveText, { id: 'headline', default: 'Ship faster', goal: 'signup' }),
      { wrapper: wrapper() },
    );

    // The override is read post-mount (hydration-safe). Let effects settle.
    await waitFor(() => expect(getByText('Ship faster')).toBeTruthy());
    await act(async () => { await Promise.resolve(); });

    // Forced variant: no network assign, no exposure, no goal ("no events
    // recorded, weights unchanged") — the same contract <Adaptive> honors.
    expect(client.assign).not.toHaveBeenCalled();
    expect(client.track).not.toHaveBeenCalled();
    expect(client.goal).not.toHaveBeenCalled();
    // No cached content for the forced variant, so the default copy shows.
    expect(getByText('Ship faster')).toBeTruthy();

    delete window.__sentient_overrides;
  });

  it('renders a custom tag via the component prop', () => {
    mockedInit.mockReturnValue(makeClient() as never);
    const { container } = render(
      createElement(AdaptiveText, { id: 'headline', default: 'Hi', component: 'h1' }),
      { wrapper: wrapper() },
    );
    expect(container.querySelector('h1')?.textContent).toBe('Hi');
  });
});
