import { renderHook } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { createElement, type ReactNode } from 'react';
import { applyScenario, resetScenario } from './testing/scenario.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { useSlotConfig } from './use-slot-config.js';
import { init } from '@sentientui/core';

vi.mock('@sentientui/core', () => ({
  init: vi.fn(),
  detectDeviceClass: () => 'desktop',
  detectTrafficSource: () => 'direct',
  armOfResult: (r: string | Record<string, string>) =>
    typeof r === 'string'
      ? r
      : Object.keys(r).sort().map((k) => `${k}=${r[k]}`).join('|'),
}));
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn() }));

const mockedInit = vi.mocked(init);

const CFG_ENTRY = { kind: 'arms' as const, content: 'Generated headline' };
const PALETTE = { primaryBg: '#111827', primaryText: '#ffffff', radius: '4px' };

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getAssignment: vi.fn().mockReturnValue(null),
    assign: vi.fn().mockResolvedValue(null),
    decide: vi.fn().mockResolvedValue(null),
    getSlotResult: vi.fn().mockReturnValue(null),
    getSlotConfig: vi.fn().mockReturnValue(null),
    getSitePalette: vi.fn().mockReturnValue(null),
    reportSlots: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  mockedInit.mockReturnValue(makeClient() as never);
});

afterEach(() => {
  resetScenario();
});

describe('useSlotConfig resolution order', () => {
  it('returns none/null with no provider data', () => {
    const { result } = renderHook(() => useSlotConfig('hero'), { wrapper: wrapperWith() });
    expect(result.current).toEqual({ config: null, arm: '', palette: null, source: 'none' });
  });

  it('returns the SSR-preloaded entry with source preloaded (and on the server render)', () => {
    const wrapper = wrapperWith({
      initialSlotConfig: { hero: CFG_ENTRY },
      initialPalette: PALETTE,
      initialSlots: { hero: 'researcher_v1' },
    });
    const { result } = renderHook(() => useSlotConfig('hero'), { wrapper });
    expect(result.current.config).toEqual(CFG_ENTRY);
    expect(result.current.arm).toBe('researcher_v1');
    expect(result.current.palette).toEqual(PALETTE);
    expect(result.current.source).toBe('preloaded');

    // SSR: same resolution with no window — must not throw and must agree.
    function Probe() {
      const r = useSlotConfig('hero');
      return createElement('span', null, `${r.source}:${r.arm}`);
    }
    const Wrapper = wrapper;
    const html = renderToString(createElement(Wrapper, null, createElement(Probe)));
    expect(html).toContain('preloaded:researcher_v1');
  });

  it('falls through to client.getSlotConfig with the client-served arm', () => {
    mockedInit.mockReturnValue(
      makeClient({
        getSlotConfig: vi.fn().mockReturnValue(CFG_ENTRY),
        getSlotResult: vi.fn().mockReturnValue('researcher_v1'),
        getSitePalette: vi.fn().mockReturnValue(PALETTE),
      }) as never,
    );
    const { result, rerender } = renderHook(() => useSlotConfig('hero'), { wrapper: wrapperWith() });
    rerender(); // provider init effect has set the client by now
    expect(result.current.config).toEqual(CFG_ENTRY);
    expect(result.current.arm).toBe('researcher_v1');
    expect(result.current.palette).toEqual(PALETTE);
    expect(result.current.source).toBe('client');
  });

  it('a slotConfig override wins and is invisible to the SSR snapshot', () => {
    applyScenario({
      slotConfig: { hero: { kind: 'arms', content: 'Forced copy' } },
      slots: { hero: 'forced_arm' },
    });
    const { result } = renderHook(() => useSlotConfig('hero'), {
      wrapper: wrapperWith({ initialSlotConfig: { hero: CFG_ENTRY } }),
    });
    expect(result.current.config).toEqual({ kind: 'arms', content: 'Forced copy' });
    expect(result.current.arm).toBe('forced_arm');
    expect(result.current.source).toBe('override');

    // Server snapshot must not see the override (hydration discipline).
    function Probe() {
      const r = useSlotConfig('hero');
      return createElement('span', null, r.source);
    }
    const Wrapper = wrapperWith({ initialSlotConfig: { hero: CFG_ENTRY } });
    const html = renderToString(createElement(Wrapper, null, createElement(Probe)));
    expect(html).toContain('preloaded');
  });

  it('applyScenario({ slotConfig }) writes the override store', () => {
    applyScenario({ slotConfig: { hero: CFG_ENTRY } });
    const w = window as unknown as { __sentient_slot_config_overrides?: Record<string, unknown> };
    expect(w.__sentient_slot_config_overrides).toEqual({ hero: CFG_ENTRY });
    resetScenario();
    expect(w.__sentient_slot_config_overrides).toBeUndefined();
  });
});

describe('first-seen registration', () => {
  it('reports an unserved slot id on a keyed client, and not when config exists', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const { rerender } = renderHook(() => useSlotConfig('brand-new-slot'), { wrapper: wrapperWith() });
    rerender(); // client lands after the provider init effect
    expect(client.reportSlots).toHaveBeenCalledWith(['brand-new-slot']);

    const served = makeClient({ getSlotConfig: vi.fn().mockReturnValue(CFG_ENTRY), getSlotResult: vi.fn().mockReturnValue('v1') });
    mockedInit.mockReturnValue(served as never);
    const second = renderHook(() => useSlotConfig('served-slot'), { wrapper: wrapperWith() });
    second.rerender();
    expect(served.reportSlots).not.toHaveBeenCalled();
  });
});