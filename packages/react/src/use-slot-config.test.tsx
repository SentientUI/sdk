import { act, renderHook } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { createElement, type ReactNode } from 'react';
import { applyScenario, resetScenario } from './testing/scenario.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { useSlotConfig } from './use-slot-config.js';
import { init } from '@sentientui/core';

vi.mock('@sentientui/core', () => ({
  // AdaptiveSlot imports `reveal` from core. These mocks are deliberately
  // minimal — they exist so the suite never loads real core — so every core
  // import the rendered tree makes has to be listed here.
  reveal: vi.fn(),
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
    flush: vi.fn(), dispose: vi.fn(),
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
      initialSlots: { hero: 'evaluator_v1' },
    });
    const { result } = renderHook(() => useSlotConfig('hero'), { wrapper });
    expect(result.current.config).toEqual(CFG_ENTRY);
    expect(result.current.arm).toBe('evaluator_v1');
    expect(result.current.palette).toEqual(PALETTE);
    expect(result.current.source).toBe('preloaded');

    // SSR: same resolution with no window — must not throw and must agree.
    function Probe() {
      const r = useSlotConfig('hero');
      return createElement('span', null, `${r.source}:${r.arm}`);
    }
    const Wrapper = wrapper;
    const html = renderToString(createElement(Wrapper, null, createElement(Probe)));
    expect(html).toContain('preloaded:evaluator_v1');
  });

  it('falls through to client.getSlotConfig with the client-served arm', () => {
    mockedInit.mockReturnValue(
      makeClient({
        getSlotConfig: vi.fn().mockReturnValue(CFG_ENTRY),
        getSlotResult: vi.fn().mockReturnValue('evaluator_v1'),
        getSitePalette: vi.fn().mockReturnValue(PALETTE),
      }) as never,
    );
    const { result, rerender } = renderHook(() => useSlotConfig('hero'), { wrapper: wrapperWith() });
    rerender(); // provider init effect has set the client by now
    expect(result.current.config).toEqual(CFG_ENTRY);
    expect(result.current.arm).toBe('evaluator_v1');
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

describe('local mode', () => {
  it('never issues a registry decide and warns that only initialSlotConfig serves', () => {
    // The local engine has no registry: decide({ slotsFrom: 'registry' }) ran
    // the whole engine once per mounted slot and could never yield a config —
    // and the old early return also hid the "this slot will never serve"
    // warning from exactly the integrators who needed it.
    const client = makeClient({ isLocal: true });
    mockedInit.mockReturnValue(client as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { rerender } = renderHook(() => useSlotConfig('local-only-slot'), { wrapper: wrapperWith() });
    rerender(); // client lands after the provider init effect
    expect(client.decide).not.toHaveBeenCalled();
    expect(client.reportSlots).not.toHaveBeenCalled(); // no server to register with

    const warns = warn.mock.calls.filter((c) => String(c[0]).includes('local-only-slot'));
    expect(warns).toHaveLength(1);
    expect(String(warns[0]![0])).toContain('initialSlotConfig');
    rerender(); // once per slot, not per render
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('local-only-slot'))).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('mounted-slot registry decide (requestSlots)', () => {
  it('asks the client for an unserved slot instead of only registering it', () => {
    // Before requestSlots a keyed client only registered the id: nothing ever
    // decided a registry slot client-side, so outside an SSR registry preload
    // the slot rendered its children forever.
    const requestSlots = vi.fn();
    const client = makeClient({ requestSlots, onSlotsChanged: vi.fn(() => () => undefined) });
    mockedInit.mockReturnValue(client as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { rerender } = renderHook(() => useSlotConfig('csr-keyed-slot'), { wrapper: wrapperWith() });
    rerender();
    expect(requestSlots).toHaveBeenCalledWith(['csr-keyed-slot']);
    expect(client.reportSlots).not.toHaveBeenCalled(); // requestSlots registers what is unpublished
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('csr-keyed-slot'))).toHaveLength(0);
    warn.mockRestore();
  });

  it('still asks for a snapshot-seeded slot, but never for a preloaded one', () => {
    // The snapshot is the LAST visit's answer; this session needs its own
    // decision (or to learn the slot was unpublished).
    const seededRequest = vi.fn();
    const seeded = makeClient({
      requestSlots: seededRequest,
      onSlotsChanged: vi.fn(() => () => undefined),
      getSlotConfig: vi.fn().mockReturnValue(CFG_ENTRY),
      getSlotResult: vi.fn().mockReturnValue('v1'),
    });
    mockedInit.mockReturnValue(seeded as never);
    const a = renderHook(() => useSlotConfig('seeded-slot'), { wrapper: wrapperWith() });
    a.rerender();
    expect(seededRequest).toHaveBeenCalledWith(['seeded-slot']);

    const preloadedRequest = vi.fn();
    const preloadedClient = makeClient({ requestSlots: preloadedRequest, onSlotsChanged: vi.fn(() => () => undefined) });
    mockedInit.mockReturnValue(preloadedClient as never);
    const b = renderHook(() => useSlotConfig('ssr-slot'), {
      wrapper: wrapperWith({ initialSlotConfig: { 'ssr-slot': CFG_ENTRY }, initialSlots: { 'ssr-slot': 'v1' } }),
    });
    b.rerender();
    expect(preloadedRequest).not.toHaveBeenCalled();
  });

  it('re-renders with the served version when the client reports a change', () => {
    let notify: () => void = () => undefined;
    let config: unknown = null;
    const client = makeClient({
      requestSlots: vi.fn(),
      onSlotsChanged: vi.fn((cb: () => void) => { notify = cb; return () => undefined; }),
      getSlotConfig: vi.fn(() => config),
      getSlotResult: vi.fn(() => (config ? 'v1' : null)),
    });
    mockedInit.mockReturnValue(client as never);
    const { result, rerender } = renderHook(() => useSlotConfig('late-slot'), { wrapper: wrapperWith() });
    rerender();
    expect(result.current.source).toBe('none');

    act(() => { config = CFG_ENTRY; notify(); });
    expect(result.current.source).toBe('client');
    expect(result.current.config).toEqual(CFG_ENTRY);
    expect(result.current.arm).toBe('v1');
  });
});
