import { render, fireEvent, act, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { useAdaptive } from './use-adaptive.js';
import { init, attachMicroSignalDetectors } from '@sentientui/core';

vi.mock('@sentientui/core', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@sentientui/core');
  return { ...actual, init: vi.fn(), attachMicroSignalDetectors: vi.fn(() => () => undefined) };
});
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn() }));

const mockedInit = vi.mocked(init);

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getAssignment: vi.fn().mockReturnValue({
      variantId: 'calm',
      assignedAt: Date.now(),
      segment: 'desktop:direct',
      confidence: 1,
    }),
    assign: vi.fn().mockResolvedValue({ variantId: 'calm', assignmentTtlMs: 0 }),
    decide: vi.fn().mockResolvedValue(null),
    getSlotResult: vi.fn().mockReturnValue(null),
    getPersona: vi.fn().mockReturnValue(null),
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
    apiKey: 'pk_test',
    context: 'saas',
    consent: true,
    children,
  } as never);
}

function BuyBox(props: { id?: string; bind?: boolean; manualGoal?: boolean }) {
  const { variant, value, bind, fireGoal } = useAdaptive(props.id ?? 'buy-box', {
    variants: { calm: 'Calm buy box', urgent: 'URGENT buy box' },
    goal: 'buy_click',
  });
  if (props.manualGoal) {
    return createElement('button', { onClick: () => fireGoal('custom_goal', { reward: 0.5 }) }, value);
  }
  return createElement(
    'div',
    props.bind === false ? {} : { ...bind },
    createElement('button', null, `${variant}:${value}`),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.stubGlobal('IntersectionObserver', vi.fn(() => ({ observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() })));
  mockedInit.mockReturnValue(makeClient() as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__sentient_overrides;
});

describe('useAdaptive â€” dev override suppresses tracking', () => {
  it('wires no exposure, goal, or micro-signal tracking while a variant is forced', () => {
    window.__sentient_overrides = { 'buy-box': 'urgent' };
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);

    const { getByText } = render(createElement(BuyBox), { wrapper });
    const btn = getByText('urgent:URGENT buy box');
    fireEvent.click(btn);

    expect(client.track).not.toHaveBeenCalled();
    expect(client.goal).not.toHaveBeenCalled();
  });
});

describe('useAdaptive â€” variant selection', () => {
  it('serves the cached/assigned variant and its value', () => {
    const { getByText } = render(createElement(BuyBox), { wrapper });
    expect(getByText('calm:Calm buy box')).toBeTruthy();
  });

  it('honors the scenario/test override global (same mechanism as useAssignment)', () => {
    window.__sentient_overrides = { 'buy-box': 'urgent' };
    const { getByText, container } = render(createElement(BuyBox), { wrapper });
    expect(getByText('urgent:URGENT buy box')).toBeTruthy();
    expect(container.querySelector('[data-sentient-variant="urgent"]')).toBeTruthy();
    expect(container.querySelector('[data-sentient-id="buy-box"]')).toBeTruthy();
  });
});

describe('useAdaptive â€” bind wiring', () => {
  it('fires the goal through the bound element on click, once', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const { getByText } = render(createElement(BuyBox), { wrapper });

    fireEvent.click(getByText('calm:Calm buy box'));
    fireEvent.click(getByText('calm:Calm buy box'));

    const goalEvents = client.track.mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).eventType === 'goal_achieved',
    );
    expect(goalEvents).toHaveLength(1);
    expect(goalEvents[0]![0]).toMatchObject({
      componentId: 'buy-box',
      variantId: 'calm',
      goalType: 'buy_click',
    });
    expect(client.goal).toHaveBeenCalledWith('buy_click', { componentId: 'buy-box', variantId: 'calm' }, 1.0, 0);
  });

  it('tracks variant_assigned exposure once when bind attaches', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const { rerender } = render(createElement(BuyBox), { wrapper });
    rerender(createElement(BuyBox));

    const exposures = client.track.mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).eventType === 'variant_assigned',
    );
    expect(exposures).toHaveLength(1);
    expect(exposures[0]![0]).toMatchObject({ componentId: 'buy-box', variantId: 'calm' });
  });

  it('does not fire a phantom baseline exposure before assign resolves (#1)', async () => {
    // Same CSR two-step resolution as <Adaptive>: no cache â†’ interim baseline
    // ('calm' = variantIds[0]) then the bandit choice ('urgent'). Only the
    // settled variant may emit an exposure.
    const client = makeClient({
      getAssignment: vi.fn().mockReturnValue(null),
      assign: vi.fn().mockResolvedValue({ variantId: 'urgent', assignmentTtlMs: 0 }),
    });
    mockedInit.mockReturnValue(client as never);

    const { findByText } = render(createElement(BuyBox), { wrapper });
    await findByText('urgent:URGENT buy box');

    await waitFor(() => {
      const exposures = client.track.mock.calls.filter(
        (call: unknown[]) => (call[0] as Record<string, unknown>).eventType === 'variant_assigned',
      );
      expect(exposures).toHaveLength(1);
      expect(exposures[0]![0]).toMatchObject({ componentId: 'buy-box', variantId: 'urgent' });
    });

    const baselineExposures = client.track.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).eventType === 'variant_assigned' &&
        (call[0] as Record<string, unknown>).variantId === 'calm',
    );
    expect(baselineExposures).toHaveLength(0);
  });

  it('attaches micro-signal detectors to the bound node', () => {
    render(createElement(BuyBox), { wrapper });
    expect(vi.mocked(attachMicroSignalDetectors)).toHaveBeenCalledTimes(1);
  });

  it('warns in dev when bind is never attached after mount', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(createElement(BuyBox, { id: 'unbound-box', bind: false }), { wrapper });
    await act(() => new Promise((r) => setTimeout(r, 5)));
    const unboundWarnings = warnSpy.mock.calls.filter(([m]) => String(m).includes('bind was never attached'));
    expect(unboundWarnings).toHaveLength(1);
    expect(String(unboundWarnings[0]![0])).toContain('unbound-box');
    warnSpy.mockRestore();
  });
});

describe('useAdaptive â€” fireGoal and goal requirement', () => {
  it('fireGoal delegates to componentGoal with the slot id', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const { getByText } = render(createElement(BuyBox, { manualGoal: true }), { wrapper });
    fireEvent.click(getByText('Calm buy box'));
    expect(client.componentGoal).toHaveBeenCalledWith('buy-box', 'custom_goal', { reward: 0.5 });
  });

  it('fireGoal also writes the session goal-funnel record (client.goal)', () => {
    // Matches <Adaptive>: componentGoal credits the bandit, goal() feeds the
    // session funnel. A manual conversion must appear in both, not just CVR.
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const { getByText } = render(createElement(BuyBox, { manualGoal: true }), { wrapper });
    fireEvent.click(getByText('Calm buy box'));
    expect(client.goal).toHaveBeenCalledWith('custom_goal', {}, 0.5, 0);
  });

  it('throws in dev when goal is missing', () => {
    function Broken() {
      useAdaptive('broken', { variants: { a: 1, b: 2 } } as never);
      return null;
    }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(createElement(Broken), { wrapper })).toThrow(/goal is required/);
    errSpy.mockRestore();
  });
});
