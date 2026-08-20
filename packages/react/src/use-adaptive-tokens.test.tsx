import { render, fireEvent } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { useAdaptiveTokens } from './use-adaptive-tokens.js';
import { getRegistered, getRegisteredSlots } from './devtools-registry.js';
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

function TokensProbe(props: { id: string; goal?: string }) {
  const t = useAdaptiveTokens(props.id, { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] }, props.goal ? { goal: props.goal } : undefined);
  return createElement(
    'section',
    { ...t.props, 'data-testid': 'probe' },
    createElement('button', null, `cta:${t.tokens.tone}`),
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

describe('useAdaptiveTokens â€” tokens and props', () => {
  it('returns preloaded token values as tokens and data-<dim> props', () => {
    const { getByTestId } = render(createElement(TokensProbe, { id: 'hero-t1' }), {
      wrapper: wrapperWith({ initialSlots: { 'hero-t1': { tone: 'urgent', motion: 'pulse' } } }),
    });
    const el = getByTestId('probe');
    expect(el.getAttribute('data-tone')).toBe('urgent');
    expect(el.getAttribute('data-motion')).toBe('pulse');
    expect(el.getAttribute('data-sentient-slot')).toBe('hero-t1');
    expect(el.textContent).toBe('cta:urgent');
  });

  it('falls back to first-declared values (baseline) with no data anywhere', () => {
    const { getByTestId } = render(createElement(TokensProbe, { id: 'hero-t2' }), {
      wrapper: wrapperWith(),
    });
    expect(getByTestId('probe').getAttribute('data-tone')).toBe('calm');
    expect(getByTestId('probe').getAttribute('data-motion')).toBe('none');
  });
});

describe('useAdaptiveTokens â€” SSR serialization', () => {
  it('server HTML carries the decided values and hydration with the same initialSlots matches', () => {
    const ui = createElement(
      wrapperWith({ initialSlots: { 'hero-t3': { tone: 'urgent', motion: 'none' } } }),
      null,
      createElement(TokensProbe, { id: 'hero-t3' }),
    );
    const html = renderToString(ui);
    expect(html).toContain('data-tone="urgent"');

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

describe('useAdaptiveTokens â€” learning wiring', () => {
  it('fires the variant_assigned exposure exactly once, with the canonical arm', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const { rerender } = render(createElement(TokensProbe, { id: 'hero-t4' }), {
      wrapper: wrapperWith({ initialSlots: { 'hero-t4': { tone: 'urgent', motion: 'none' } } }),
    });
    rerender(createElement(TokensProbe, { id: 'hero-t4' }));

    const exposures = client.track.mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).eventType === 'variant_assigned',
    );
    expect(exposures).toHaveLength(1);
    expect(exposures[0]![0]).toMatchObject({
      componentId: 'hero-t4',
      variantId: 'motion=none|tone=urgent',
    });
  });

  it('does not fire an exposure for an unresolved baseline slot (#2)', async () => {
    // Keyed client, no SSR preload, no cached slot result â†’ the slot serves the
    // declared baseline and never decides. It must NOT record a variant_assigned
    // for that baseline (a phantom impression that can never convert).
    const client = makeClient(); // isLocal undefined = keyed
    mockedInit.mockReturnValue(client as never);
    render(createElement(TokensProbe, { id: 'hero-baseline-exp' }), { wrapper: wrapperWith() });

    await new Promise((r) => setTimeout(r, 10));
    const exposures = client.track.mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).eventType === 'variant_assigned',
    );
    expect(exposures).toHaveLength(0);
  });

  it('warns once in dev that a keyed baseline slot needs SSR/decide (#2)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const { rerender } = render(createElement(TokensProbe, { id: 'hero-baseline-warn' }), {
      wrapper: wrapperWith(),
    });
    rerender(createElement(TokensProbe, { id: 'hero-baseline-warn' }));

    await new Promise((r) => setTimeout(r, 0));
    const baselineWarnings = warnSpy.mock.calls.filter(([m]) =>
      String(m).includes('resolved to its baseline'),
    );
    expect(baselineWarnings).toHaveLength(1);
    expect(String(baselineWarnings[0]![0])).toContain('hero-baseline-warn');
    warnSpy.mockRestore();
  });

  it('wires the declared goal through componentGoal with componentId = slot id', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const { getByText } = render(createElement(TokensProbe, { id: 'hero-t5', goal: 'buy_click' }), {
      wrapper: wrapperWith({ initialSlots: { 'hero-t5': { tone: 'calm', motion: 'none' } } }),
    });
    fireEvent.click(getByText('cta:calm'));
    expect(client.componentGoal).toHaveBeenCalledTimes(1);
    expect(client.componentGoal).toHaveBeenCalledWith('hero-t5', 'buy_click');
    fireEvent.click(getByText('cta:calm'));
    expect(client.componentGoal).toHaveBeenCalledTimes(1); // latched once
  });

  it('also writes the session goal-funnel record (client.goal), matching <Adaptive>', () => {
    // componentGoal credits the bandit; goal() feeds the session goal funnel.
    // Slots that fire only componentGoal are invisible in the funnel — fire both.
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const { getByText } = render(createElement(TokensProbe, { id: 'hero-fn', goal: 'buy_click' }), {
      wrapper: wrapperWith({ initialSlots: { 'hero-fn': { tone: 'calm', motion: 'none' } } }),
    });
    fireEvent.click(getByText('cta:calm'));
    expect(client.goal).toHaveBeenCalledTimes(1);
    expect(client.goal).toHaveBeenCalledWith('buy_click', {
      metadata: { componentId: 'hero-fn', arm: 'motion=none|tone=calm' },
      weight: 1.0,
      stepIndex: 0,
    });
  });

  it('records nothing for a forced (override) arm — no exposure, no goals', () => {
    // A devtools/test override is a preview; it must not train the optimizer nor
    // populate the funnel (same "no events, weights unchanged" contract as
    // component overrides in <Adaptive>).
    window.__sentient_slot_overrides = { 'hero-ov': { tone: 'urgent', motion: 'pulse' } };
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const { getByText } = render(createElement(TokensProbe, { id: 'hero-ov', goal: 'buy_click' }), {
      wrapper: wrapperWith(),
    });
    fireEvent.click(getByText('cta:urgent'));
    const exposures = client.track.mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).eventType === 'variant_assigned',
    );
    expect(exposures).toHaveLength(0);
    expect(client.componentGoal).not.toHaveBeenCalled();
    expect(client.goal).not.toHaveBeenCalled();
  });

  it('registers the slot in the devtools SLOT registry with its dims (not as a fake component)', () => {
    render(createElement(TokensProbe, { id: 'hero-t6' }), { wrapper: wrapperWith() });
    const slot = getRegisteredSlots().find((s) => s.id === 'hero-t6');
    expect(slot).toBeDefined();
    expect(slot!.dims).toEqual({ tone: ['calm', 'urgent'], motion: ['none', 'pulse'] });
    // Slots must NOT pollute the component registry â€” that produced broken devtools
    // buttons writing the wrong override channel.
    expect(getRegistered().find((c) => c.id === 'hero-t6')).toBeUndefined();
  });
});

describe('useAdaptiveTokens â€” goal binding hardening (#4)', () => {
  function UnboundProbe(props: { id: string }) {
    // Declares a goal but never spreads t.props onto any element.
    useAdaptiveTokens(props.id, { tone: ['calm', 'urgent'] }, { goal: 'buy_click' });
    return createElement('section', { 'data-testid': 'unbound' }, 'no props spread');
  }

  function EscProbe(props: { id: string }) {
    const t = useAdaptiveTokens(props.id, { tone: ['calm', 'urgent'] }, { goal: 'buy_click' });
    return createElement('section', t.props, createElement('button', null, 'go'));
  }

  it('warns once (no throw) when a goal is declared but no element carries the slot props', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);

    expect(() =>
      render(createElement(UnboundProbe, { id: 'hero-unbound' }), {
        wrapper: wrapperWith({ initialSlots: { 'hero-unbound': { tone: 'calm' } } }),
      }),
    ).not.toThrow();

    const warns = warnSpy.mock.calls.filter(([m]) =>
      String(m).includes('no element carries the returned props'),
    );
    expect(warns).toHaveLength(1);
    expect(String(warns[0]![0])).toContain('hero-unbound');
    expect(client.componentGoal).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('escapes a CSS-special slot id (double-quote) so the goal binds to the right element', () => {
    // An unescaped `"` in the id would break out of `[data-sentient-slot="â€¦"]`;
    // the (jsdom) CSS.escape path must keep the selector valid and matching.
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const id = 'hero"promo';
    const { getByText } = render(createElement(EscProbe, { id }), {
      wrapper: wrapperWith({ initialSlots: { [id]: { tone: 'calm' } } }),
    });
    fireEvent.click(getByText('go'));
    expect(client.componentGoal).toHaveBeenCalledWith(id, 'buy_click');
  });

  it('binds via the hardened fallback (backslash id) when CSS.escape is unavailable', () => {
    // Force the no-CSS.escape branch: the old fallback escaped only `"`, leaving
    // a `\` that CSS reads as an escape (matching the wrong node / no node). The
    // hardened fallback escapes `\` too, so a backslash id still binds.
    const savedCSS = (globalThis as { CSS?: unknown }).CSS;
    delete (globalThis as { CSS?: unknown }).CSS;
    try {
      const client = makeClient();
      mockedInit.mockReturnValue(client as never);
      const id = 'hero\\promo';
      const { getByText } = render(createElement(EscProbe, { id }), {
        wrapper: wrapperWith({ initialSlots: { [id]: { tone: 'calm' } } }),
      });
      fireEvent.click(getByText('go'));
      expect(client.componentGoal).toHaveBeenCalledWith(id, 'buy_click');
    } finally {
      (globalThis as { CSS?: unknown }).CSS = savedCSS;
    }
  });
});

describe('useAdaptiveTokens â€” dev warnings', () => {
  function BigProbe() {
    const t = useAdaptiveTokens('hero-big', {
      tone: ['calm', 'urgent', 'playful'],
      motion: ['none', 'pulse'],
    });
    return createElement('div', t.props);
  }
  function SmallProbe() {
    const t = useAdaptiveTokens('hero-small', { tone: ['calm', 'urgent'] });
    return createElement('div', t.props);
  }

  it('warns once when the declared space exceeds 4 effective arms (3Ã—2=6), not for â‰¤4', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { rerender } = render(createElement(BigProbe), { wrapper: wrapperWith() });
    rerender(createElement(BigProbe));
    render(createElement(SmallProbe), { wrapper: wrapperWith() });

    const armWarnings = warnSpy.mock.calls.filter(([m]) => String(m).includes('more than the recommended 4'));
    expect(armWarnings).toHaveLength(1);
    expect(String(armWarnings[0]![0])).toContain('hero-big');
    warnSpy.mockRestore();
  });
});
