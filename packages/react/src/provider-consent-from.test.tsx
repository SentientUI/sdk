// @vitest-environment jsdom
import { render, act, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { init } from '@sentientui/core';

vi.mock('@sentientui/core', () => ({
  init: vi.fn(),
  // AdaptiveSlot imports `reveal` from core. These mocks are deliberately
  // minimal — they exist so the suite never loads real core — so every core
  // import the rendered tree makes has to be listed here.
  reveal: vi.fn(),
}));
vi.mock('@sentientui/core/graph', () => ({ init: vi.fn() }));
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn() }));

const mockedInit = vi.mocked(init);

function makeClient() {
  return {
    getAssignment: vi.fn().mockReturnValue(null),
    assign: vi.fn().mockResolvedValue(null),
    destroy: vi.fn(),
    flush: vi.fn(), dispose: vi.fn(),
    track: vi.fn(),
    goal: vi.fn(),
    componentGoal: vi.fn(),
    identify: vi.fn(),
    getGraph: vi.fn().mockReturnValue({ pageNodes: [], capturedAt: 0 }),
    fetchWeights: vi.fn().mockResolvedValue([]),
    decide: vi.fn().mockResolvedValue(null),
    getSlotResult: vi.fn().mockReturnValue(null),
    getSlotConfig: vi.fn().mockReturnValue(null),
    getSitePalette: vi.fn().mockReturnValue(null),
    reportSlots: vi.fn(),
    getPersona: vi.fn().mockReturnValue(null),
  };
}

const COOKIE = 'my_consent';
const EVENT = 'my-consent-decided';

/** The consent watcher is a lazily loaded core entry: let it arrive and
 *  subscribe, as it does on a real page, before asserting. */
async function renderProvider(extra: Record<string, unknown> = {}) {
  const r = render(
    createElement(AdaptiveProvider, {
      apiKey: 'pk_test_key_1234',
      context: 'saas',
      enableGraph: false,
      consentFrom: { cookie: COOKIE, value: 'accepted', event: EVENT },
      children: null,
      ...extra,
    } as never),
  );
  await act(async () => {
    await import('@sentientui/core/consent');
    await new Promise((res) => setTimeout(res, 0));
  });
  return r;
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
  it('initialises nothing while the cookie is absent', async () => {
    await renderProvider();
    expect(mockedInit).not.toHaveBeenCalled();
  });

  it('initialises nothing when the cookie says declined', async () => {
    document.cookie = `${COOKIE}=declined; Path=/`;
    await renderProvider();
    expect(mockedInit).not.toHaveBeenCalled();
  });

  it('initialises on mount when the cookie already grants consent', async () => {
    document.cookie = `${COOKIE}=accepted; Path=/`;
    await renderProvider();
    expect(mockedInit).toHaveBeenCalledTimes(1);
    expect(mockedInit.mock.calls[0]![0]).toMatchObject({ consent: true });
  });

  // The point of the prop: no host-app glue, no ordering rules, no reload.
  it('initialises when the decision event fires, with no reload', async () => {
    await renderProvider();
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
  it('stays gated when the event fires but the source still says no', async () => {
    await renderProvider();
    act(() => {
      document.cookie = `${COOKIE}=declined; Path=/`;
      window.dispatchEvent(new CustomEvent(EVENT));
    });
    expect(mockedInit).not.toHaveBeenCalled();
  });

  it('accepts a predicate for CMPs that expose an object instead of a cookie', async () => {
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
    await act(async () => {
      await import('@sentientui/core/consent');
      await new Promise((res) => setTimeout(res, 0));
    });
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
  it('tears the client down when the source reports consent withdrawn', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    await renderProvider();
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
  it('observes a revocation even when consent was granted at mount', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    document.cookie = `${COOKIE}=accepted; Path=/`;
    await renderProvider();
    expect(mockedInit).toHaveBeenCalledTimes(1);

    act(() => {
      document.cookie = `${COOKIE}=declined; Path=/`;
      window.dispatchEvent(new CustomEvent(EVENT));
    });
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(mockedInit).toHaveBeenCalledTimes(1);
  });

  it('re-grants after a revocation when the source grants again', async () => {
    await renderProvider();
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
  it('honours a server-resolved consent={true} immediately', async () => {
    // Own key: "the source has answered" is per page load and per project, and
    // earlier tests answered for the default key.
    await renderProvider({ consent: true, apiKey: 'pk_test_fresh_srv1' });
    expect(mockedInit).toHaveBeenCalledTimes(1);
  });

  it('stops listening once unmounted', async () => {
    const { unmount } = await renderProvider();
    unmount();
    act(() => {
      document.cookie = `${COOKIE}=accepted; Path=/`;
      window.dispatchEvent(new CustomEvent(EVENT));
    });
    expect(mockedInit).not.toHaveBeenCalled();
  });

  it('leaves the plain consent prop behaviour untouched when consentFrom is absent', async () => {
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

// Consent platform presets (2026-09-24).
describe('AdaptiveProvider — consentFrom presets', () => {
  const w = window as unknown as Record<string, unknown>;
  afterEach(() => {
    delete w.Cookiebot;
    delete w.OnetrustActiveGroups;
    delete w.getCkyConsent;
  });

  it('a server-resolved grant yields to a mid-visit revocation (the old `consent || source` never re-gated)', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    w.Cookiebot = { consent: { statistics: true } };
    await renderProvider({ consentFrom: 'cookiebot', consent: true });
    expect(mockedInit).toHaveBeenCalledTimes(1);
    act(() => {
      w.Cookiebot = { consent: { statistics: false }, hasResponse: true };
      window.dispatchEvent(new Event('CookiebotOnDecline'));
    });
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it('a false that is not a refusal (TCF banner reopened) pauses without forgetting (review M2)', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    let listener: ((d: unknown, ok: boolean) => void) | undefined;
    w.__tcfapi = (cmd: string, _v: number, cb: (d: unknown, ok: boolean) => void) => {
      if (cmd === 'addEventListener') listener = cb;
    };
    await renderProvider({ consentFrom: 'tcf' });
    act(() => listener!({ eventStatus: 'tcloaded', gdprApplies: true, purpose: { consents: { 1: true, 5: true, 6: true, 8: true } } }, true));
    expect(mockedInit).toHaveBeenCalledTimes(1);
    act(() => listener!({ eventStatus: 'cmpuishown', gdprApplies: true }, true));
    expect(client.dispose).toHaveBeenCalled();
    expect(client.destroy).not.toHaveBeenCalled();
    delete w.__tcfapi;
  });

  it('keeps the server grant while the platform has not loaded yet (unknown is not "no")', async () => {
    await renderProvider({ consentFrom: 'tcf', consent: true, apiKey: 'pk_test_fresh_tcf1' });
    expect(mockedInit).toHaveBeenCalledTimes(1);
  });

  it('OneTrust: initialises when OneTrustGroupsUpdated reports the Performance group', async () => {
    await renderProvider({ consentFrom: 'onetrust' });
    expect(mockedInit).not.toHaveBeenCalled();
    act(() => {
      w.OnetrustActiveGroups = ',C0001,C0002,';
      window.dispatchEvent(new Event('OneTrustGroupsUpdated'));
    });
    expect(mockedInit).toHaveBeenCalledTimes(1);
  });

  it('CookieYes: hears the decision on document', async () => {
    await renderProvider({ consentFrom: 'cookieyes' });
    act(() => {
      w.getCkyConsent = () => ({ categories: { analytics: true } });
      document.dispatchEvent(new CustomEvent('cookieyes_consent_update', { detail: { accepted: ['analytics'], rejected: [] } }));
    });
    expect(mockedInit).toHaveBeenCalledTimes(1);
  });
});

describe('a refusal already in place at boot forgets the visitor (audit N2)', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    document.cookie = `${COOKIE}=; max-age=0; path=/`;
  });

  it('no tracking client ever exists, yet the stored identity and snapshot are deleted', async () => {
    const sfx = 'pk_test_key_1234'.slice(0, 12);
    localStorage.setItem(`_snt_uid_${sfx}`, 'old-visitor');
    localStorage.setItem('_snt_snap:pk_test_key_1234', '{}');
    document.cookie = `${COOKIE}=rejected; path=/`;
    await renderProvider();
    expect(localStorage.getItem(`_snt_uid_${sfx}`)).toBeNull();
    expect(localStorage.getItem('_snt_snap:pk_test_key_1234')).toBeNull();
    expect(mockedInit).not.toHaveBeenCalled();
  });

  it('an undecided visitor (no cookie yet) keeps their identity', async () => {
    const sfx = 'pk_test_key_1234'.slice(0, 12);
    localStorage.setItem(`_snt_uid_${sfx}`, 'returning');
    await renderProvider();
    expect(localStorage.getItem(`_snt_uid_${sfx}`)).toBe('returning');
  });
});

describe('held conversions and a refusal (grader F-R1)', () => {
  afterEach(() => {
    cleanup();
    document.cookie = `${COOKIE}=; max-age=0; path=/`;
  });

  it('refuse, then accept in the same page view: goals held before the refusal are never sent', async () => {
    const held: Array<(c: { goal: (n: string) => void }) => void> = [(c) => c.goal('before_refusal')];
    // Like core's proxy: dispose() drops what it held.
    const gated = { ...makeClient(), gated: true, takeHeld: vi.fn(() => held.splice(0)), dispose: vi.fn(() => void held.splice(0)) };
    const tracking = makeClient();
    mockedInit.mockImplementation(((c: { consent?: boolean }) => (c.consent === false ? gated : tracking)) as never);
    await renderProvider({ preConsentBehavior: 'statistical_winner' });
    act(() => {
      document.cookie = `${COOKIE}=rejected; path=/`;
      window.dispatchEvent(new CustomEvent(EVENT));
    });
    act(() => {
      document.cookie = `${COOKIE}=accepted; path=/`;
      window.dispatchEvent(new CustomEvent(EVENT));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mockedInit).toHaveBeenCalledWith(expect.objectContaining({ consent: true }));
    expect(tracking.goal).not.toHaveBeenCalled();
  });

  it('accept without a refusal: held goals ARE handed to the tracking client', async () => {
    const held: Array<(c: { goal: (n: string) => void }) => void> = [(c) => c.goal('while_pending')];
    const gated = { ...makeClient(), gated: true, takeHeld: vi.fn(() => held.splice(0)) };
    const tracking = makeClient();
    mockedInit.mockImplementation(((c: { consent?: boolean }) => (c.consent === false ? gated : tracking)) as never);
    await renderProvider({ preConsentBehavior: 'statistical_winner' });
    act(() => {
      document.cookie = `${COOKIE}=accepted; path=/`;
      window.dispatchEvent(new CustomEvent(EVENT));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(tracking.goal).toHaveBeenCalledWith('while_pending');
  });
});

describe('custom check source: refused reads the latest render (review R7 #4)', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });
  it('a "no" set after mount forgets the visitor', async () => {
    const sfx = 'pk_test_key_1234'.slice(0, 12);
    localStorage.setItem(`_snt_uid_${sfx}`, 'returning');
    const r = render(
      createElement(AdaptiveProvider, {
        apiKey: 'pk_test_key_1234',
        enableGraph: false,
        consentFrom: { check: () => false, refused: () => false, event: EVENT },
        children: null,
      } as never),
    );
    await act(async () => {
      await import('@sentientui/core/consent');
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(localStorage.getItem(`_snt_uid_${sfx}`)).toBe('returning');
    // Same shape, new closures: the site's state now says "refused".
    r.rerender(
      createElement(AdaptiveProvider, {
        apiKey: 'pk_test_key_1234',
        enableGraph: false,
        consentFrom: { check: () => false, refused: () => true, event: EVENT },
        children: null,
      } as never),
    );
    act(() => {
      window.dispatchEvent(new CustomEvent(EVENT));
    });
    expect(localStorage.getItem(`_snt_uid_${sfx}`)).toBeNull();
  });
});
