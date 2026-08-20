import { render, fireEvent } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { AdaptiveGroup } from './adaptive-group.js';
import { init } from '@sentientui/core';

vi.mock('@sentientui/core', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@sentientui/core');
  return { ...actual, init: vi.fn() };
});
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn() }));

const mockedInit = vi.mocked(init);

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getAssignment: vi.fn().mockReturnValue(null),
    assign: vi.fn().mockResolvedValue(null),
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

function wrapperWith(props: Record<string, unknown> = {}) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(AdaptiveProvider, {
      enableGraph: false,
      apiKey: 'pk_test',
      context: 'saas',
      consent: true,
      ...props,
      children,
    } as never);
  };
}

function group(id: string, extra: Record<string, unknown> = {}) {
  return createElement(
    AdaptiveGroup,
    {
      id,
      arrangements: {
        standard: ['plans', 'faq', 'social'],
        social_first: ['social', 'plans', 'faq'],
      },
      ...extra,
    } as never,
    createElement('div', { key: 'plans' }, 'PLANS'),
    createElement('div', { key: 'faq' }, 'FAQ'),
    createElement('div', { key: 'social' }, 'SOCIAL'),
  );
}

function textOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-sentient-id] > div')).map(
    (n) => n.textContent ?? '',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mockedInit.mockReturnValue(makeClient() as never);
});

afterEach(() => {
  delete window.__sentient_slot_overrides;
});

describe('AdaptiveGroup â€” reorder correctness', () => {
  it('renders declaration order for the baseline (first arrangement)', () => {
    const { container } = render(group('pricing-g1'), { wrapper: wrapperWith() });
    expect(textOrder(container)).toEqual(['PLANS', 'FAQ', 'SOCIAL']);
    expect(container.querySelector('[data-sentient-variant="standard"]')).toBeTruthy();
  });

  it('reorders keyed children per the decided arrangement', () => {
    const { container } = render(group('pricing-g2'), {
      wrapper: wrapperWith({ initialSlots: { 'pricing-g2': 'social_first' } }),
    });
    expect(textOrder(container)).toEqual(['SOCIAL', 'PLANS', 'FAQ']);
    expect(container.querySelector('[data-sentient-variant="social_first"]')).toBeTruthy();
  });

  it('honors the slot override global (scenario forcing)', () => {
    window.__sentient_slot_overrides = { 'pricing-g3': 'social_first' };
    const { container } = render(group('pricing-g3'), { wrapper: wrapperWith() });
    expect(textOrder(container)).toEqual(['SOCIAL', 'PLANS', 'FAQ']);
  });
});

describe('AdaptiveGroup â€” fail-safe', () => {
  it('renders declaration order when the decided arrangement references a missing child key', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const el = createElement(
      AdaptiveGroup,
      {
        id: 'pricing-g4',
        arrangements: { standard: ['plans', 'faq'], flipped: ['faq', 'missing'] },
      } as never,
      createElement('div', { key: 'plans' }, 'PLANS'),
      createElement('div', { key: 'faq' }, 'FAQ'),
    );
    const { container } = render(el, {
      wrapper: wrapperWith({ initialSlots: { 'pricing-g4': 'flipped' } }),
    });
    expect(textOrder(container)).toEqual(['PLANS', 'FAQ']); // declaration order
    expect(warnSpy.mock.calls.some(([m]) => String(m).includes('fail-safe'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('renders declaration order for an unknown decided arrangement id', () => {
    const { container } = render(group('pricing-g5'), {
      wrapper: wrapperWith({ initialSlots: { 'pricing-g5': 'retired_arm' } }),
    });
    expect(textOrder(container)).toEqual(['PLANS', 'FAQ', 'SOCIAL']);
  });
});

describe('AdaptiveGroup â€” dev warnings', () => {
  it('warns once when an explicit baseline is not the first-declared arrangement', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { rerender } = render(group('pricing-g6', { baseline: 'social_first' }), {
      wrapper: wrapperWith(),
    });
    rerender(group('pricing-g6', { baseline: 'social_first' }));
    const warnings = warnSpy.mock.calls.filter(([m]) => String(m).includes('not the first-declared'));
    expect(warnings).toHaveLength(1);
    warnSpy.mockRestore();
  });
});

describe('AdaptiveGroup â€” SSR parity', () => {
  it('server HTML and hydrated client agree when initialSlots match', () => {
    const ui = createElement(
      wrapperWith({ initialSlots: { 'pricing-g7': 'social_first' } }),
      null,
      createElement(
        AdaptiveGroup,
        { id: 'pricing-g7', arrangements: { standard: ['a', 'b'], social_first: ['b', 'a'] } } as never,
        createElement('span', { key: 'a' }, 'A'),
        createElement('span', { key: 'b' }, 'B'),
      ),
    );
    const html = renderToString(ui);
    expect(html.indexOf('B')).toBeLessThan(html.indexOf('A')); // decided order in SSR HTML

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(ui, { container, hydrate: true });
    expect(errSpy).not.toHaveBeenCalled(); // no hydration mismatch
    errSpy.mockRestore();
    container.remove();
  });
});

describe('AdaptiveGroup â€” learning wiring', () => {
  it('fires variant_assigned exposure once with the arrangement id as variantId', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const { rerender } = render(group('pricing-g8'), {
      wrapper: wrapperWith({ initialSlots: { 'pricing-g8': 'social_first' } }),
    });
    rerender(group('pricing-g8'));
    const exposures = client.track.mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).eventType === 'variant_assigned',
    );
    expect(exposures).toHaveLength(1);
    expect(exposures[0]![0]).toMatchObject({ componentId: 'pricing-g8', variantId: 'social_first' });
  });

  it('does not fire an exposure for an unresolved baseline group (#2)', async () => {
    // Keyed client, no SSR preload â†’ the group renders its baseline arrangement
    // and never decides. It must NOT record a variant_assigned for the baseline
    // arm (a phantom impression that can never convert).
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    render(group('pricing-baseline-exp'), { wrapper: wrapperWith() });

    await new Promise((r) => setTimeout(r, 10));
    const exposures = client.track.mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).eventType === 'variant_assigned',
    );
    expect(exposures).toHaveLength(0);
  });

  it('credits a declared goal via componentGoal(group id), latched once', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const el = createElement(
      AdaptiveGroup,
      { id: 'pricing-g9', arrangements: { standard: ['x'] }, goal: 'plan_click' } as never,
      createElement('button', { key: 'x' }, 'CHOOSE'),
    );
    const { getByText } = render(el, { wrapper: wrapperWith() });
    fireEvent.click(getByText('CHOOSE'));
    fireEvent.click(getByText('CHOOSE'));
    expect(client.componentGoal).toHaveBeenCalledTimes(1);
    expect(client.componentGoal).toHaveBeenCalledWith('pricing-g9', 'plan_click');
  });

  it('also writes the session goal-funnel record (client.goal), matching <Adaptive>', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const el = createElement(
      AdaptiveGroup,
      { id: 'pricing-g10', arrangements: { standard: ['x'] }, goal: 'plan_click' } as never,
      createElement('button', { key: 'x' }, 'CHOOSE'),
    );
    const { getByText } = render(el, { wrapper: wrapperWith() });
    fireEvent.click(getByText('CHOOSE'));
    expect(client.goal).toHaveBeenCalledTimes(1);
    expect(client.goal).toHaveBeenCalledWith('plan_click', {
      metadata: { componentId: 'pricing-g10', arm: 'standard' }, weight: 1.0, stepIndex: 0,
    });
  });

  it('records nothing for a forced (override) arrangement — no exposure, no goals', () => {
    window.__sentient_slot_overrides = { 'pricing-g11': 'social_first' };
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const el = createElement(
      AdaptiveGroup,
      {
        id: 'pricing-g11',
        arrangements: { standard: ['plans'], social_first: ['plans'] },
        goal: 'plan_click',
      } as never,
      createElement('button', { key: 'plans' }, 'CHOOSE'),
    );
    const { getByText } = render(el, { wrapper: wrapperWith() });
    fireEvent.click(getByText('CHOOSE'));
    const exposures = client.track.mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).eventType === 'variant_assigned',
    );
    expect(exposures).toHaveLength(0);
    expect(client.componentGoal).not.toHaveBeenCalled();
    expect(client.goal).not.toHaveBeenCalled();
  });
});
