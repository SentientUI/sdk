import { renderHook, render, act, waitFor } from '@testing-library/react';
import { createElement, useState, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdaptiveProvider, useSentient } from './provider.js';
import { init } from '@sentientui/core';
import { init as initGraph } from '@sentientui/core/graph';

vi.mock('@sentientui/core', () => ({ init: vi.fn() }));
vi.mock('@sentientui/core/graph', () => ({ init: vi.fn() }));
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn() }));

import { startEngagementCapture } from '@sentientui/core/engagement';

const mockedInit = vi.mocked(init);
const mockedInitGraph = vi.mocked(initGraph);
const mockedStartEngagement = vi.mocked(startEngagementCapture);

function makeClient() {
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
  };
}

// Generic consent/lifecycle wrappers pin enableGraph:false — they exercise the
// synchronous lean path; the default (graph-on) path has its own suite below.
function makeStaticWrapper(consent: boolean | undefined) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(AdaptiveProvider, {
      apiKey: 'pk_test_key_1234',
      context: 'saas',
      consent,
      enableGraph: false,
      children,
    });
  };
}

// Wrapper that exposes a setter so tests can flip consent after mount.
function makeDynamicWrapper(initial: boolean | undefined) {
  let externalSet: ((v: boolean | undefined) => void) | null = null;

  function DynamicWrapper({ children }: { children: ReactNode }) {
    const [consent, setConsent] = useState<boolean | undefined>(initial);
    externalSet = setConsent;
    return createElement(AdaptiveProvider, {
      apiKey: 'pk_test_key_1234',
      context: 'saas',
      consent,
      enableGraph: false,
      children,
    });
  }

  return {
    Wrapper: DynamicWrapper,
    setConsent: (v: boolean | undefined) => externalSet?.(v),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AdaptiveProvider — consent=false', () => {
  it('does not call init', () => {
    renderHook(() => useSentient(), { wrapper: makeStaticWrapper(false) });
    expect(mockedInit).not.toHaveBeenCalled();
  });

  it('exposes null client', () => {
    const { result } = renderHook(() => useSentient(), {
      wrapper: makeStaticWrapper(false),
    });
    expect(result.current).toBeNull();
  });
});

describe('AdaptiveProvider — consent=true', () => {
  it('calls init once and exposes the client', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { result } = renderHook(() => useSentient(), {
      wrapper: makeStaticWrapper(true),
    });

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(mockedInit).toHaveBeenCalledOnce();
    expect(result.current).toBe(client);
  });
});

describe('AdaptiveProvider — preConsentBehavior', () => {
  it('calls init with preConsentBehavior when consent is false', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { result } = renderHook(() => useSentient(), {
      wrapper: ({ children }) =>
        createElement(AdaptiveProvider, {
          apiKey: 'pk_test_key_1234',
          context: 'saas',
          consent: false,
          preConsentBehavior: 'statistical_winner',
          enableGraph: false,
          children,
        }),
    });

    await waitFor(() => expect(result.current).not.toBeNull());

    expect(mockedInit).toHaveBeenCalledWith(
      expect.objectContaining({ consent: false, preConsentBehavior: 'statistical_winner' }),
    );
    expect(result.current).toBe(client);
  });

  it('still nulls client when consent is false without preConsentBehavior', () => {
    const { result } = renderHook(() => useSentient(), {
      wrapper: ({ children }) =>
        createElement(AdaptiveProvider, {
          apiKey: 'pk_test_key_1234',
          context: 'saas',
          consent: false,
          children,
        }),
    });
    expect(mockedInit).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});

describe('AdaptiveProvider — consent lifecycle', () => {
  it('destroys client and nulls it when consent changes to false', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { Wrapper, setConsent } = makeDynamicWrapper(true);
    const { result } = renderHook(() => useSentient(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current).not.toBeNull());

    act(() => setConsent(false));

    await waitFor(() => expect(result.current).toBeNull());
    // destroy is called by both the effect cleanup and the consent=false branch
    expect(client.destroy).toHaveBeenCalled();
  });

  it('re-initialises when consent changes from false to true', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { Wrapper, setConsent } = makeDynamicWrapper(false);
    const { result } = renderHook(() => useSentient(), { wrapper: Wrapper });

    expect(result.current).toBeNull();
    expect(mockedInit).not.toHaveBeenCalled();

    act(() => setConsent(true));

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(mockedInit).toHaveBeenCalledOnce();
  });
});

describe('AdaptiveProvider — enableGraph', () => {
  it('uses graph init BY DEFAULT (enableGraph unset)', async () => {
    const client = makeClient();
    mockedInitGraph.mockReturnValue(client as ReturnType<typeof init>);

    const { result } = renderHook(() => useSentient(), {
      wrapper: ({ children }) =>
        createElement(AdaptiveProvider, {
          apiKey: 'pk_test_key_1234',
          context: 'saas',
          consent: true,
          children,
        }),
    });

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(mockedInitGraph).toHaveBeenCalledOnce();
    expect(mockedInitGraph).toHaveBeenCalledWith(expect.objectContaining({ graph: true }));
    expect(mockedInit).not.toHaveBeenCalled();
  });

  it('uses lean init and never imports the graph entry when enableGraph is false', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { result } = renderHook(() => useSentient(), {
      wrapper: makeStaticWrapper(true),
    });

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(mockedInit).toHaveBeenCalledOnce();
    expect(mockedInitGraph).not.toHaveBeenCalled();
  });

  it('uses graph init with graph:true when enableGraph is true', async () => {
    const client = makeClient();
    mockedInitGraph.mockReturnValue(client as ReturnType<typeof init>);

    const { result } = renderHook(() => useSentient(), {
      wrapper: ({ children }) =>
        createElement(AdaptiveProvider, {
          apiKey: 'pk_test_key_1234',
          context: 'saas',
          consent: true,
          enableGraph: true,
          children,
        }),
    });

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(mockedInitGraph).toHaveBeenCalledOnce();
    expect(mockedInitGraph).toHaveBeenCalledWith(
      expect.objectContaining({ graph: true, apiKey: 'pk_test_key_1234' }),
    );
    expect(mockedInit).not.toHaveBeenCalled();
    expect(result.current).toBe(client);
  });

  it('does not create a graph client when unmounted before the dynamic import resolves', async () => {
    const client = makeClient();
    mockedInitGraph.mockReturnValue(client as ReturnType<typeof init>);

    const { unmount } = renderHook(() => useSentient(), {
      wrapper: ({ children }) =>
        createElement(AdaptiveProvider, {
          apiKey: 'pk_test_key_1234',
          context: 'saas',
          consent: true,
          enableGraph: true,
          children,
        }),
    });

    // Unmount synchronously, before the import() microtask resolves.
    unmount();
    // Flush pending microtasks so the .then callback runs and sees cancelled.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedInitGraph).not.toHaveBeenCalled();
  });

  it('still nulls client when consent is false even with enableGraph true', () => {
    const { result } = renderHook(() => useSentient(), {
      wrapper: ({ children }) =>
        createElement(AdaptiveProvider, {
          apiKey: 'pk_test_key_1234',
          context: 'saas',
          consent: false,
          enableGraph: true,
          children,
        }),
    });
    expect(mockedInit).not.toHaveBeenCalled();
    expect(mockedInitGraph).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});

describe('AdaptiveProvider — engagement capture', () => {
  it('starts engagement capture by default once a client exists', async () => {
    const client = makeClient();
    mockedInitGraph.mockReturnValue(client as ReturnType<typeof init>);
    mockedStartEngagement.mockReturnValue(vi.fn());

    renderHook(() => useSentient(), {
      wrapper: ({ children }) =>
        createElement(AdaptiveProvider, {
          apiKey: 'pk_test_key_1234',
          context: 'saas',
          consent: true,
          children,
        }),
    });

    await waitFor(() => expect(mockedStartEngagement).toHaveBeenCalledOnce());
    expect(mockedStartEngagement).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ apiKey: 'pk_test_key_1234' }),
    );
  });

  it('does not start engagement when engagement={false}', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { result } = renderHook(() => useSentient(), {
      wrapper: ({ children }) =>
        createElement(AdaptiveProvider, {
          apiKey: 'pk_test_key_1234',
          context: 'saas',
          consent: true,
          enableGraph: false,
          engagement: false,
          children,
        }),
    });

    await waitFor(() => expect(result.current).not.toBeNull());
    // Flush microtasks — a wrongly-scheduled start would have resolved by now.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockedStartEngagement).not.toHaveBeenCalled();
  });

  it('does not start engagement when consent is false (no client)', async () => {
    renderHook(() => useSentient(), { wrapper: makeStaticWrapper(false) });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockedStartEngagement).not.toHaveBeenCalled();
  });

  it('stops engagement capture on unmount', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);
    const stop = vi.fn();
    mockedStartEngagement.mockReturnValue(stop);

    const { unmount } = renderHook(() => useSentient(), {
      wrapper: makeStaticWrapper(true),
    });
    await waitFor(() => expect(mockedStartEngagement).toHaveBeenCalledOnce());

    unmount();
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe('AdaptiveProvider — teardown semantics (dispose vs destroy)', () => {
  it('unmount disposes the client (visitor identity survives), never destroys it', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { result, unmount } = renderHook(() => useSentient(), {
      wrapper: makeStaticWrapper(true),
    });
    await waitFor(() => expect(result.current).not.toBeNull());

    unmount();

    // destroy() deletes the _snt_uid cookie — on routine unmount (StrictMode
    // double-effects, route-level providers) that would rotate the visitor.
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it('consent revocation still fully destroys the client (forget-me)', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { Wrapper, setConsent } = makeDynamicWrapper(true);
    const { result } = renderHook(() => useSentient(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());

    act(() => setConsent(false));

    expect(client.destroy).toHaveBeenCalled();
  });
});

describe('AdaptiveProvider — frozen config dev warning (#6)', () => {
  it('warns (dev) when apiKey changes after init, but not on unrelated re-renders', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let setKey!: (k: string) => void;
    let setUnrelated!: (n: number) => void;

    function Harness() {
      const [key, sk] = useState('pk_test_key_1234');
      const [n, sn] = useState(0);
      setKey = sk;
      setUnrelated = sn;
      return createElement(AdaptiveProvider, {
        apiKey: key,
        context: 'saas',
        consent: true,
        enableGraph: false,
        children: createElement('span', null, `n:${n}`),
      });
    }

    render(createElement(Harness));

    const frozenWarns = () =>
      warnSpy.mock.calls.filter(([m]) => String(m).includes('changed after initialisation'));

    // An unrelated re-render (apiKey/context/country/apiBaseUrl unchanged) is silent.
    act(() => setUnrelated(1));
    expect(frozenWarns()).toHaveLength(0);

    // Changing the frozen apiKey after init warns exactly once, naming the prop.
    act(() => setKey('pk_test_key_changed'));
    const keyWarns = warnSpy.mock.calls.filter(([m]) =>
      String(m).includes('`apiKey` changed after initialisation'),
    );
    expect(keyWarns).toHaveLength(1);

    warnSpy.mockRestore();
  });
});
