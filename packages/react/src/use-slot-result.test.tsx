import { renderHook, render, waitFor, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { createElement, type ReactNode } from 'react';
import { applyScenario, resetScenario } from './testing/scenario.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { useSlotResult, useAdaptivePersona } from './use-slot-result.js';
import { init } from '@sentientui/core';

vi.mock('@sentientui/core', () => ({
  init: vi.fn(),
  detectDeviceClass: () => 'desktop',
  detectTrafficSource: () => 'direct',
  baselineResultFor: (d: { arms?: string[]; dims?: Record<string, readonly string[]> }) =>
    d.arms
      ? d.arms[0]
      : Object.fromEntries(Object.entries(d.dims ?? {}).map(([k, v]) => [k, v[0]])),
  armOfResult: (r: string | Record<string, string>) =>
    typeof r === 'string'
      ? r
      : Object.keys(r).sort().map((k) => `${k}=${r[k]}`).join('|'),
}));
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

const DIMS_DECL = { id: 'hero', dims: { tone: ['calm', 'urgent'] as const } };

beforeEach(() => {
  vi.clearAllMocks();
  mockedInit.mockReturnValue(makeClient() as never);
});

afterEach(() => {
  delete window.__sentient_slot_overrides;
  delete window.__sentient_persona_override;
  window.history.replaceState(null, '', '/');
});

describe('useSlotResult resolution order', () => {
  it('window.__sentient_slot_overrides wins over everything', async () => {
    window.__sentient_slot_overrides = { hero: { tone: 'urgent' } };
    const { result } = renderHook(() => useSlotResult('hero', DIMS_DECL), {
      wrapper: wrapperWith({ initialSlots: { hero: { tone: 'calm' } } }),
    });
    expect(result.current).toEqual({ result: { tone: 'urgent' }, arm: 'tone=urgent', source: 'override' });
  });

  it('preloaded initialSlots come second', () => {
    const { result } = renderHook(() => useSlotResult('hero', DIMS_DECL), {
      wrapper: wrapperWith({ initialSlots: { hero: { tone: 'urgent' } } }),
    });
    expect(result.current.source).toBe('preloaded');
    expect(result.current.result).toEqual({ tone: 'urgent' });
  });

  it('falls through to client.getSlotResult (decide cache / snapshot)', async () => {
    mockedInit.mockReturnValue(
      makeClient({ getSlotResult: vi.fn().mockReturnValue({ tone: 'urgent' }) }) as never,
    );
    const { result, rerender } = renderHook(() => useSlotResult('hero', DIMS_DECL), {
      wrapper: wrapperWith(),
    });
    rerender(); // provider init effect has set the client by now
    expect(result.current.source).toBe('client');
    expect(result.current.result).toEqual({ tone: 'urgent' });
  });

  it('resolves to the declared baseline when nothing else knows the slot', () => {
    const { result } = renderHook(() => useSlotResult('hero', DIMS_DECL), {
      wrapper: wrapperWith(),
    });
    expect(result.current).toEqual({ result: { tone: 'calm' }, arm: 'tone=calm', source: 'baseline' });
  });

  it('handles enumerated-arms declarations', () => {
    const { result } = renderHook(
      () => useSlotResult('pricing-area', { id: 'pricing-area', arms: ['standard', 'social_first'] }),
      { wrapper: wrapperWith() },
    );
    expect(result.current).toEqual({ result: 'standard', arm: 'standard', source: 'baseline' });
  });

  it('local mode: lazily decides an undecided slot and re-renders with the result', async () => {
    // CSR-only keyless page: no override, no preload, no snapshot â€” the local
    // client must be asked to decide, and the hook must pick up the result.
    let decided: Record<string, unknown> | null = null;
    const client = makeClient({
      isLocal: true,
      decide: vi.fn().mockImplementation(async (input: { slots?: Array<{ id: string }> }) => {
        decided = { slots: { [input.slots![0].id]: { tone: 'urgent' } } };
        return decided;
      }),
      getSlotResult: vi.fn().mockImplementation((id: string) =>
        decided ? (decided.slots as Record<string, unknown>)[id] ?? null : null,
      ),
    });
    mockedInit.mockReturnValue(client as never);
    const { result } = renderHook(() => useSlotResult('hero', DIMS_DECL), {
      wrapper: wrapperWith(),
    });
    expect(result.current.source).toBe('baseline'); // first paint
    await vi.waitFor(() => expect(result.current.source).toBe('client'));
    expect(result.current.result).toEqual({ tone: 'urgent' });
    expect(client.decide).toHaveBeenCalledTimes(1);
    expect(client.decide).toHaveBeenCalledWith({ slots: [DIMS_DECL] });
  });

  it('keyed mode: warns once in dev that a baseline slot needs SSR/decide (#2)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = makeClient(); // keyed
    mockedInit.mockReturnValue(client as never);
    const { rerender } = renderHook(() => useSlotResult('hero-warn-slot', DIMS_DECL), {
      wrapper: wrapperWith(),
    });
    rerender();
    await new Promise((r) => setTimeout(r, 0));
    const warnings = warnSpy.mock.calls.filter(([m]) => String(m).includes('resolved to its baseline'));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]![0])).toContain('hero-warn-slot');
    warnSpy.mockRestore();
  });

  it('local mode: does not warn about a baseline first paint (decide is pending) (#2)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = makeClient({ isLocal: true }); // decide resolves null â†’ stays baseline transiently
    mockedInit.mockReturnValue(client as never);
    renderHook(() => useSlotResult('hero-local-nowarn', DIMS_DECL), { wrapper: wrapperWith() });
    await new Promise((r) => setTimeout(r, 0));
    const warnings = warnSpy.mock.calls.filter(([m]) => String(m).includes('resolved to its baseline'));
    expect(warnings).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('keyed mode: never fires a client-side decide for baseline slots', async () => {
    const client = makeClient(); // isLocal undefined = keyed
    mockedInit.mockReturnValue(client as never);
    const { result, rerender } = renderHook(() => useSlotResult('hero', DIMS_DECL), {
      wrapper: wrapperWith(),
    });
    rerender();
    expect(result.current.source).toBe('baseline');
    await new Promise((r) => setTimeout(r, 10));
    expect(client.decide).not.toHaveBeenCalled();
  });
});

describe('useAdaptivePersona', () => {
  it('honors window.__sentient_persona_override first', () => {
    window.__sentient_persona_override = { persona: 'buyer', confidence: 0.5 };
    const { result } = renderHook(() => useAdaptivePersona(), {
      wrapper: wrapperWith({ initialPersona: { persona: 'browser', confidence: 0.9 } }),
    });
    expect(result.current).toEqual({ persona: 'buyer', confidence: 0.5, band: 'medium' });
  });

  it('honors the ?sentient_persona= URL override (mirrors ?sentient_variant=)', () => {
    window.history.replaceState(null, '', '/?sentient_persona=deal_seeker');
    const { result } = renderHook(() => useAdaptivePersona(), { wrapper: wrapperWith() });
    expect(result.current).toEqual({ persona: 'deal_seeker', confidence: 1, band: 'high' });
  });

  it('uses context initialPersona, then client.getPersona()', () => {
    const { result } = renderHook(() => useAdaptivePersona(), {
      wrapper: wrapperWith({ initialPersona: { persona: 'researcher', confidence: 0.2 } }),
    });
    expect(result.current).toEqual({ persona: 'researcher', confidence: 0.2, band: 'low' });

    mockedInit.mockReturnValue(
      makeClient({
        getPersona: vi.fn().mockReturnValue({ persona: 'buyer', confidence: 0.8, band: 'high' }),
      }) as never,
    );
    const second = renderHook(() => useAdaptivePersona(), { wrapper: wrapperWith() });
    second.rerender();
    expect(second.result.current).toEqual({ persona: 'buyer', confidence: 0.8, band: 'high' });
  });

  it('returns null when nothing is known', () => {
    const { result } = renderHook(() => useAdaptivePersona(), { wrapper: wrapperWith() });
    expect(result.current).toBeNull();
  });

  it('re-renders when applyScenario forces a persona mid-session (override bus notified)', () => {
    const { result } = renderHook(() => useAdaptivePersona(), { wrapper: wrapperWith() });
    expect(result.current).toBeNull();
    act(() => {
      applyScenario({ persona: 'buyer', confidence: 0.5 });
    });
    expect(result.current).toEqual({ persona: 'buyer', confidence: 0.5, band: 'medium' });
    act(() => {
      resetScenario();
    });
    expect(result.current).toBeNull();
  });

  it('is hydration-safe: SSR uses initialPersona, then applies the override post-mount with no mismatch', async () => {
    function Probe() {
      const p = useAdaptivePersona();
      return createElement('span', null, p ? p.persona : 'none');
    }
    const tree = createElement(
      wrapperWith({ initialPersona: { persona: 'browser', confidence: 0.9 } }),
      null,
      createElement(Probe),
    );

    // Server render uses only the SSR-provided persona (window/client not read).
    const html = renderToString(tree);
    expect(html).toContain('browser');

    // Force a persona, then hydrate the server HTML. The first client render
    // still uses initialPersona (matches the server → no mismatch), then the
    // post-mount read applies the override.
    window.__sentient_persona_override = { persona: 'buyer', confidence: 0.5 };
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(tree, { container, hydrate: true });
    expect(errSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(container.textContent).toBe('buyer'));
    errSpy.mockRestore();
    container.remove();
  });
});
