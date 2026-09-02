// @vitest-environment jsdom
import { render, act, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { init } from '@sentientui/core';

vi.mock('@sentientui/core', () => ({ init: vi.fn() }));
vi.mock('@sentientui/core/graph', () => ({ init: vi.fn() }));
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn() }));

const mockedInit = vi.mocked(init);

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

const COOKIE = 'my_consent';
const EVENT = 'my-consent-decided';

function renderProvider(extra: Record<string, unknown> = {}) {
  return render(
    createElement(AdaptiveProvider, {
      apiKey: 'pk_test_key_1234',
      context: 'saas',
      enableGraph: false,
      consentFrom: { cookie: COOKIE, value: 'accepted', event: EVENT },
      children: null,
      ...extra,
    } as never),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedInit.mockReturnValue(makeClient() as never);
});

afterEach(() => {
  cleanup();
  document.cookie = `${COOKIE}=; Path=/; Max-Age=0`;
});

describe('AdaptiveProvider — consentFrom', () => {
  it('initialises nothing while the cookie is absent', () => {
    renderProvider();
    expect(mockedInit).not.toHaveBeenCalled();
  });

  it('initialises nothing when the cookie says declined', () => {
    document.cookie = `${COOKIE}=declined; Path=/`;
    renderProvider();
    expect(mockedInit).not.toHaveBeenCalled();
  });

  it('initialises on mount when the cookie already grants consent', () => {
    document.cookie = `${COOKIE}=accepted; Path=/`;
    renderProvider();
    expect(mockedInit).toHaveBeenCalledTimes(1);
    expect(mockedInit.mock.calls[0]![0]).toMatchObject({ consent: true });
  });

  // The point of the prop: no host-app glue, no ordering rules, no reload.
  it('initialises when the decision event fires, with no reload', () => {
    renderProvider();
    expect(mockedInit).not.toHaveBeenCalled();

    act(() => {
      document.cookie = `${COOKIE}=accepted; Path=/`;
      window.dispatchEvent(new CustomEvent(EVENT));
    });

    expect(mockedInit).toHaveBeenCalledTimes(1);
    expect(mockedInit.mock.calls[0]![0]).toMatchObject({ consent: true });
  });

  // Re-reads the source rather than trusting the event payload, so it works
  // with any CMP's event (CookiebotOnAccept, OneTrustGroupsUpdated, …).
  it('stays gated when the event fires but the source still says no', () => {
    renderProvider();
    act(() => {
      document.cookie = `${COOKIE}=declined; Path=/`;
      window.dispatchEvent(new CustomEvent(EVENT));
    });
    expect(mockedInit).not.toHaveBeenCalled();
  });

  it('accepts a predicate for CMPs that expose an object instead of a cookie', () => {
    let granted = false;
    render(
      createElement(AdaptiveProvider, {
        apiKey: 'pk_test_key_1234',
        context: 'saas',
        enableGraph: false,
        consentFrom: { check: () => granted, event: EVENT },
        children: null,
      } as never),
    );
    expect(mockedInit).not.toHaveBeenCalled();

    act(() => {
      granted = true;
      window.dispatchEvent(new CustomEvent(EVENT));
    });
    expect(mockedInit).toHaveBeenCalledTimes(1);
  });

  // The gate must be symmetric: consent is not a one-way door. `granted` used
  // to latch true, so a CMP decision event AFTER the user withdrew consent
  // never re-gated the SDK — tracking continued against an explicit
  // revocation for the rest of the visit.
  it('tears the client down when the source reports consent withdrawn', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    renderProvider();
    act(() => {
      document.cookie = `${COOKIE}=accepted; Path=/`;
      window.dispatchEvent(new CustomEvent(EVENT));
    });
    expect(mockedInit).toHaveBeenCalledTimes(1);

    act(() => {
      document.cookie = `${COOKIE}=declined; Path=/`;
      window.dispatchEvent(new CustomEvent(EVENT));
    });
    expect(client.destroy).toHaveBeenCalledTimes(1);
    // Torn down, not re-initialised: init count is unchanged.
    expect(mockedInit).toHaveBeenCalledTimes(1);
  });

  // The sharper version of the same bug: when the mount-time read already
  // granted, the effect returned WITHOUT subscribing to the decision event at
  // all, so a later revocation was invisible even in principle.
  it('observes a revocation even when consent was granted at mount', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    document.cookie = `${COOKIE}=accepted; Path=/`;
    renderProvider();
    expect(mockedInit).toHaveBeenCalledTimes(1);

    act(() => {
      document.cookie = `${COOKIE}=declined; Path=/`;
      window.dispatchEvent(new CustomEvent(EVENT));
    });
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(mockedInit).toHaveBeenCalledTimes(1);
  });

  it('re-grants after a revocation when the source grants again', () => {
    renderProvider();
    const grant = () =>
      act(() => {
        document.cookie = `${COOKIE}=accepted; Path=/`;
        window.dispatchEvent(new CustomEvent(EVENT));
      });
    const revoke = () =>
      act(() => {
        document.cookie = `${COOKIE}=declined; Path=/`;
        window.dispatchEvent(new CustomEvent(EVENT));
      });
    grant();
    revoke();
    grant();
    // One init per grant — the cycle is symmetric in both directions.
    expect(mockedInit).toHaveBeenCalledTimes(2);
  });

  // AdaptiveRoot reads the cookie on the server and passes consent={true}, so a
  // returning visitor must not be gated waiting for a client-side re-read.
  it('honours a server-resolved consent={true} immediately', () => {
    renderProvider({ consent: true });
    expect(mockedInit).toHaveBeenCalledTimes(1);
  });

  it('stops listening once unmounted', () => {
    const { unmount } = renderProvider();
    unmount();
    act(() => {
      document.cookie = `${COOKIE}=accepted; Path=/`;
      window.dispatchEvent(new CustomEvent(EVENT));
    });
    expect(mockedInit).not.toHaveBeenCalled();
  });

  it('leaves the plain consent prop behaviour untouched when consentFrom is absent', () => {
    render(
      createElement(AdaptiveProvider, {
        apiKey: 'pk_test_key_1234',
        context: 'saas',
        enableGraph: false,
        consent: true,
        children: null,
      } as never),
    );
    expect(mockedInit).toHaveBeenCalledTimes(1);
  });
});
