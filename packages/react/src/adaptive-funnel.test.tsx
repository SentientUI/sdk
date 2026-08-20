import { render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { Adaptive } from './adaptive.js';
import { __resetFunnelDeclarations } from './adaptive-shared.js';
import { init } from '@sentientui/core';

vi.mock('@sentientui/core', () => ({
  init: vi.fn(),
  attachMicroSignalDetectors: vi.fn(() => () => undefined),
}));
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn() }));
vi.mock('./segment.js', () => ({ detectSegment: () => 'desktop:direct' }));

const mockedInit = vi.mocked(init);

function makeClient() {
  return {
    getAssignment: vi.fn().mockReturnValue({
      variantId: 'variant-a', assignedAt: Date.now(), segment: 'desktop:direct', confidence: 1,
    }),
    assign: vi.fn().mockResolvedValue({ variantId: 'variant-a', assignmentTtlMs: 0 }),
    destroy: vi.fn(), dispose: vi.fn(),
    track: vi.fn(), goal: vi.fn(), componentGoal: vi.fn(), identify: vi.fn(),
    getGraph: vi.fn().mockReturnValue({ pageNodes: [], capturedAt: 0 }),
    fetchWeights: vi.fn().mockResolvedValue([]),
    decide: vi.fn().mockResolvedValue(null),
    getSlotResult: vi.fn().mockReturnValue(null),
    getPersona: vi.fn().mockReturnValue(null),
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return createElement(AdaptiveProvider, {
    enableGraph: false, apiKey: 'pk_test_key_1234', context: 'saas', consent: true, children,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetFunnelDeclarations();
  vi.stubGlobal('IntersectionObserver', vi.fn(() => ({
    observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn(),
  })));
});

const wcGoal = {
  type: 'weighted_composite' as const,
  steps: [
    { name: 'saw_cta', weight: 0.1, goal: { type: 'scroll_depth' as const, threshold: 0.5 } },
    { name: 'clicked_cta', weight: 1, goal: { type: 'click' as const } },
  ],
};

function declCalls(client: ReturnType<typeof makeClient>) {
  return client.track.mock.calls.filter(([e]) => (e as { eventType: string }).eventType === 'funnel_declared');
}

describe('Adaptive funnel declaration', () => {
  it('sends one funnel_declared with steps for a weighted_composite + funnel prop', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as unknown as ReturnType<typeof init>);
    render(
      createElement(Adaptive, {
        id: 'hero', funnel: 'checkout', goal: wcGoal,
        variants: { 'variant-a': createElement('button', null, 'A') },
      }),
      { wrapper },
    );
    await waitFor(() => expect(declCalls(client)).toHaveLength(1));
    const [e] = declCalls(client)[0]!;
    expect((e as { componentId: string }).componentId).toBe('hero');
    expect((e as { payload: unknown }).payload).toEqual({
      funnelId: 'checkout',
      steps: [{ goalId: 'saw_cta', weight: 0.1 }, { goalId: 'clicked_cta', weight: 1 }],
    });
  });

  it('sends a membership-only payload for a plain goal', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as unknown as ReturnType<typeof init>);
    render(
      createElement(Adaptive, {
        id: 'hero', funnel: 'checkout', goal: 'click',
        variants: { 'variant-a': createElement('button', null, 'A') },
      }),
      { wrapper },
    );
    await waitFor(() => expect(declCalls(client)).toHaveLength(1));
    expect((declCalls(client)[0]![0] as { payload: unknown }).payload).toEqual({ funnelId: 'checkout' });
  });

  it('dedupes: two declarers of one funnel → one steps declaration, each registers membership', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as unknown as ReturnType<typeof init>);
    render(
      createElement('div', null,
        createElement(Adaptive, {
          id: 'hero', funnel: 'checkout', goal: wcGoal,
          variants: { 'variant-a': createElement('button', null, 'A') },
        }),
        createElement(Adaptive, {
          id: 'pricing-cta', funnel: 'checkout', goal: wcGoal,
          variants: { 'variant-a': createElement('button', null, 'B') },
        }),
      ),
      { wrapper },
    );
    await waitFor(() => expect(declCalls(client)).toHaveLength(2));
    const withSteps = declCalls(client).filter(([e]) => 'steps' in (e as { payload: Record<string, unknown> }).payload);
    expect(withSteps).toHaveLength(1);
    const componentIds = declCalls(client).map(([e]) => (e as { componentId: string }).componentId).sort();
    expect(componentIds).toEqual(['hero', 'pricing-cta']);
  });

  it('no funnel prop → zero funnel_declared events', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as unknown as ReturnType<typeof init>);
    const { findByText } = render(
      createElement(Adaptive, {
        id: 'hero', goal: 'click',
        variants: { 'variant-a': createElement('button', null, 'A') },
      }),
      { wrapper },
    );
    await findByText('A');
    expect(declCalls(client)).toHaveLength(0);
  });
});
