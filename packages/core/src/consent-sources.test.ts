// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TCModel, TCString, GVL } from '@iabtechlabtcf/core';
import {
  consentFromCookies,
  consentModeGranted,
  consentWatcher,
  cookiebotCookieGrants,
  cookieyesCookieGrants,
  onetrustCookieGrants,
  tcStringConsents,
  tcStringPurposes,
} from './consent-sources.js';

const clearCookies = () => document.cookie.split(';').forEach((c) => (document.cookie = `${c.split('=')[0]!.trim()}=; Max-Age=0; path=/`));
beforeEach(clearCookies);
afterEach(() => {
  clearCookies();
  for (const k of ['Cookiebot', 'OnetrustActiveGroups', 'getCkyConsent', '__tcfapi', 'dataLayer', 'Shopify']) delete (window as unknown as Record<string, unknown>)[k];
  vi.useRealTimers();
});

describe('Cookiebot', () => {
  // As browsers store it: single quotes and commas percent-encoded.
  const accepted = encodeURIComponent("{stamp:'aZ0',necessary:true,preferences:false,statistics:true,marketing:false,method:'explicit',ver:1,utc:1727000000000,region:'gb'}");
  const statsOff = encodeURIComponent("{stamp:'aZ0',necessary:true,preferences:true,statistics:false,marketing:true,method:'explicit',ver:1}");
  it('parses the CookieConsent cookie, including "0" and "-1"', () => {
    expect(cookiebotCookieGrants(accepted)).toBe(true);
    expect(cookiebotCookieGrants(statsOff)).toBe(false);
    expect(cookiebotCookieGrants(statsOff, 'marketing')).toBe(true);
    expect(cookiebotCookieGrants('0')).toBe(false);
    expect(cookiebotCookieGrants('-1')).toBe(true); // outside a consent region
    expect(cookiebotCookieGrants(undefined)).toBeNull();
  });
  it('the JS API wins; accept and decline events both re-read (revocation re-gates)', () => {
    const w = consentWatcher('cookiebot');
    const seen: Array<boolean | null> = [];
    const stop = w.subscribe(() => seen.push(w.read()));
    (window as unknown as Record<string, unknown>).Cookiebot = { consent: { statistics: true } };
    window.dispatchEvent(new Event('CookiebotOnAccept'));
    (window as unknown as Record<string, unknown>).Cookiebot = { consent: { statistics: false } };
    window.dispatchEvent(new Event('CookiebotOnDecline'));
    expect(seen).toEqual([true, false]);
    stop();
  });
});

describe('OneTrust', () => {
  const cookie = 'isGpcEnabled=0&datestamp=Tue+Sep+24+2026&version=202409.1.0&isIABGlobal=false&hosts=&consentId=abc&interactionCount=1&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A0%2CC0004%3A0&AwaitingReconsent=false';
  it('parses OptanonConsent groups', () => {
    expect(onetrustCookieGrants(cookie)).toBe(true);
    expect(onetrustCookieGrants(cookie, 'C0004')).toBe(false);
    expect(onetrustCookieGrants(cookie, 'C0099')).toBeNull();
  });
  it('reads OnetrustActiveGroups exactly (C0002 is not C00021)', () => {
    const w = consentWatcher({ cmp: 'onetrust' });
    (window as unknown as Record<string, unknown>).OnetrustActiveGroups = ',C0001,C00021,';
    expect(w.read()).toBe(false);
    (window as unknown as Record<string, unknown>).OnetrustActiveGroups = ',C0001,C0002,';
    expect(w.read()).toBe(true);
  });
});

describe('CookieYes', () => {
  it('parses the observed cookie format; unknown is null, not "no"', () => {
    expect(cookieyesCookieGrants('consentid:abc,consent:yes,action:yes,necessary:yes,functional:no,analytics:yes,performance:no,advertisement:no')).toBe(true);
    expect(cookieyesCookieGrants('consentid:abc,consent:no,action:yes,necessary:yes,analytics:no')).toBe(false);
    expect(cookieyesCookieGrants('something-else')).toBeNull();
  });
  it('hears cookieyes_consent_update on DOCUMENT (the generic window-only listener never did)', () => {
    const w = consentWatcher('cookieyes');
    const spy = vi.fn();
    const stop = w.subscribe(spy);
    (window as unknown as Record<string, unknown>).getCkyConsent = () => ({ categories: { analytics: true } });
    document.dispatchEvent(new CustomEvent('cookieyes_consent_update', { detail: { accepted: ['analytics'], rejected: [] } }));
    expect(spy).toHaveBeenCalledOnce();
    expect(w.read()).toBe(true);
    stop();
  });
});

describe('IAB TCF v2.2', () => {
  // Real TC strings from the IAB reference implementation.
  const encode = (purposes: number[], opts: { li?: number[]; vendors?: number[] } = {}) => {
    // The encoder drops vendors missing from the GVL, so list the ones set.
    const vendors = Object.fromEntries(
      (opts.vendors ?? []).map((id) => [id, { id, name: `v${id}`, purposes: [1], legIntPurposes: [], flexiblePurposes: [], specialPurposes: [], features: [], specialFeatures: [], policyUrl: 'https://example.com' }]),
    );
    // …and vendors that declare no consent purpose (hence purpose 1 and its definition).
    const purposeDefs = { 1: { id: 1, name: 'p1', description: '', illustrations: [] } };
    const m = new TCModel(new GVL({ vendorListVersion: 1, tcfPolicyVersion: 4, lastUpdated: new Date('2026-01-01'), purposes: purposeDefs, specialPurposes: {}, features: {}, specialFeatures: {}, vendors, stacks: {} } as never));
    m.cmpId = 10;
    m.cmpVersion = 1;
    m.purposeConsents.set(purposes);
    if (opts.li) m.purposeLegitimateInterests.set(opts.li);
    if (opts.vendors) m.vendorConsents.set(opts.vendors);
    return TCString.encode(m);
  };
  it('decodes purpose consents at the spec offset', () => {
    expect([...tcStringPurposes(encode([1, 8]))!].sort()).toEqual([1, 8]);
    expect(tcStringPurposes(encode([]))!.size).toBe(0);
    expect(tcStringPurposes('not-a-tc-string!')).toBeNull();
  });
  it('server read: granted only when every required purpose is consented', () => {
    const tc = encode([1, 7]);
    expect(consentFromCookies({ cmp: 'tcf', purposes: [1] }, (n) => (n === 'euconsent-v2' ? tc : undefined))).toBe(true);
    expect(consentFromCookies({ cmp: 'tcf', purposes: [1, 8] }, (n) => (n === 'euconsent-v2' ? tc : undefined))).toBe(false);
    expect(consentFromCookies('tcf', () => undefined)).toBeNull();
  });
  it('the preset needs storage, profiling, personalisation and measurement — purpose 1 alone is storage only (audit S7)', () => {
    const read = (tc: string) => consentFromCookies('tcf', (n) => (n === 'euconsent-v2' ? tc : undefined));
    expect(read(encode([1]))).toBe(false);
    expect(read(encode([1, 5, 6, 8]))).toBe(true);
    // Purpose 8 may rest on legitimate interest; 5 and 6 may not.
    expect(read(encode([1, 5, 6], { li: [8] }))).toBe(true);
    expect(read(encode([1, 8], { li: [5, 6] }))).toBe(false);
  });
  it('decodes vendor consents (bitfield and range encodings) and requires them when vendorId is set', () => {
    const few = encode([1, 5, 6, 8], { vendors: [3, 755] });
    expect([...tcStringConsents(few)!.vendors!].sort((a, b) => a - b)).toEqual([3, 755]);
    const many = encode([1, 5, 6, 8], { vendors: Array.from({ length: 400 }, (_, i) => i + 100) });
    const decoded = tcStringConsents(many)!.vendors!;
    expect(decoded.size).toBe(400);
    expect(decoded.has(100) && decoded.has(499) && !decoded.has(99) && !decoded.has(500)).toBe(true);
    const read = (tc: string, vendorId: number) => consentFromCookies({ cmp: 'tcf', vendorId }, (n) => (n === 'euconsent-v2' ? tc : undefined));
    expect(read(few, 755)).toBe(true);
    expect(read(few, 4)).toBe(false);
    expect(read(encode([1, 5, 6, 8]), 755)).toBe(false);
  });
  it('watches __tcfapi, treats the banner as undecided, and grants when GDPR does not apply', () => {
    let listener: ((d: unknown, ok: boolean) => void) | undefined;
    (window as unknown as Record<string, unknown>).__tcfapi = (cmd: string, _v: number, cb: (d: unknown, ok: boolean) => void) => {
      if (cmd === 'addEventListener') listener = cb;
    };
    const w = consentWatcher('tcf');
    const stop = w.subscribe(() => undefined);
    expect(w.read()).toBeNull(); // nothing from the CMP yet
    listener!({ eventStatus: 'cmpuishown', gdprApplies: true, listenerId: 1 }, true);
    expect(w.read()).toBe(false);
    listener!({ eventStatus: 'useractioncomplete', gdprApplies: true, purpose: { consents: { 1: true } } }, true);
    expect(w.read()).toBe(false); // storage only — no profiling/measurement consent
    listener!({ eventStatus: 'useractioncomplete', gdprApplies: true, purpose: { consents: { 1: true, 5: true, 6: true }, legitimateInterests: { 8: true } } }, true);
    expect(w.read()).toBe(true);
    listener!({ eventStatus: 'useractioncomplete', gdprApplies: true, purpose: { consents: { 1: false, 5: true, 6: true, 8: true } } }, true);
    expect(w.read()).toBe(false); // withdrawn
    listener!({ eventStatus: 'tcloaded', gdprApplies: false }, true);
    expect(w.read()).toBe(true);
    stop();
  });
});

describe('Google Consent Mode v2', () => {
  it('reads the latest default/update for the storage type from gtag arguments objects', () => {
    function gtag(..._a: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      ((window as unknown as { dataLayer: unknown[] }).dataLayer ??= []).push(arguments);
    }
    gtag('consent', 'default', { analytics_storage: 'denied', ad_storage: 'denied' });
    const dl = (window as unknown as { dataLayer: unknown[] }).dataLayer;
    expect(consentModeGranted(dl)).toBe(false);
    gtag('consent', 'update', { analytics_storage: 'granted' });
    expect(consentModeGranted(dl)).toBe(true);
    expect(consentModeGranted(dl, 'ad_storage')).toBe(false);
  });
  it('honours region-scoped defaults: an EU denial is not overridden by a global grant (audit P0-3)', () => {
    const dl = [
      ['consent', 'default', { analytics_storage: 'granted' }],
      ['consent', 'default', { analytics_storage: 'denied', region: ['ES', 'FR', 'US-CA'] }],
    ];
    expect(consentModeGranted(dl)).toBe(false); // region unknown: the denial may apply
    expect(consentModeGranted(dl, 'analytics_storage', 'es')).toBe(false);
    expect(consentModeGranted(dl, 'analytics_storage', 'US-CA')).toBe(false);
    expect(consentModeGranted(dl, 'analytics_storage', 'US-NY')).toBe(true);
    expect(consentModeGranted(dl, 'analytics_storage', 'GB')).toBe(true);
    // Most specific region wins.
    const nested = [
      ['consent', 'default', { analytics_storage: 'denied', region: ['US'] }],
      ['consent', 'default', { analytics_storage: 'granted', region: ['US-TX'] }],
    ];
    expect(consentModeGranted(nested, 'analytics_storage', 'US-TX')).toBe(true);
    expect(consentModeGranted(nested, 'analytics_storage', 'US-NY')).toBe(false);
    expect(consentModeGranted(nested, 'analytics_storage', 'DE')).toBeNull();
    // Region-scoped grants alone never grant an unknown-region visitor.
    expect(consentModeGranted([['consent', 'default', { analytics_storage: 'granted', region: ['US'] }]])).toBe(false);
    // An update applies everywhere.
    dl.push(['consent', 'update', { analytics_storage: 'granted' }]);
    expect(consentModeGranted(dl)).toBe(true);
    expect(consentModeGranted(dl, 'analytics_storage', 'ES')).toBe(true);
  });
  it('the watcher resolves regions from its option and folds only new entries', () => {
    const dl: unknown[] = [
      ['consent', 'default', { analytics_storage: 'granted' }],
      ['consent', 'default', { analytics_storage: 'denied', region: ['DE'] }],
    ];
    (window as unknown as { dataLayer: unknown[] }).dataLayer = dl;
    expect(consentWatcher({ cmp: 'google-consent-mode', region: 'DE' }).read()).toBe(false);
    expect(consentWatcher({ cmp: 'google-consent-mode', region: 'PT' }).read()).toBe(true);
    const w = consentWatcher('google-consent-mode');
    expect(w.read()).toBe(false);
    dl.push(['consent', 'update', { analytics_storage: 'granted' }]);
    expect(w.read()).toBe(true);
    // A replaced dataLayer restarts the fold.
    (window as unknown as { dataLayer: unknown[] }).dataLayer = [['consent', 'default', { analytics_storage: 'denied' }]];
    expect(w.read()).toBe(false);
  });
  it('polls cheaply: no callback without new entries; a non-chaining replacement is caught by the poll (audit S18)', () => {
    vi.useFakeTimers();
    (window as unknown as { dataLayer: unknown[] }).dataLayer = [];
    const w = consentWatcher('google-consent-mode');
    const spy = vi.fn();
    const stop = w.subscribe(spy);
    spy.mockClear();
    vi.advanceTimersByTime(5000);
    expect(spy).not.toHaveBeenCalled();
    const dl = (window as unknown as { dataLayer: unknown[] & { push: (...a: unknown[]) => number } }).dataLayer;
    dl.push = function (...a: unknown[]) {
      return Array.prototype.push.apply(dl, a);
    };
    dl.push(['consent', 'update', { analytics_storage: 'granted' }]);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(w.read()).toBe(true);
    stop();
  });
  it('never re-wraps a chaining replacement (gtag.js/GTM) — no mutual recursion', () => {
    vi.useFakeTimers();
    (window as unknown as { dataLayer: unknown[] }).dataLayer = [];
    const w = consentWatcher('google-consent-mode');
    const spy = vi.fn();
    const stop = w.subscribe(spy);
    const dl = (window as unknown as { dataLayer: unknown[] & { push: (...a: unknown[]) => number } }).dataLayer;
    // What gtag.js does: replace push with one that chains to the previous.
    const prev = dl.push;
    dl.push = function (...a: unknown[]) {
      return prev.apply(dl, a);
    };
    vi.advanceTimersByTime(3000); // several polls
    spy.mockClear();
    expect(() => dl.push(['consent', 'update', { analytics_storage: 'granted' }])).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1); // heard through the chain, synchronously
    expect(w.read()).toBe(true);
    stop();
  });
  it('notices updates pushed after subscribing', () => {
    (window as unknown as { dataLayer: unknown[] }).dataLayer = [['consent', 'default', { analytics_storage: 'denied' }]];
    const w = consentWatcher('google-consent-mode');
    const spy = vi.fn();
    const stop = w.subscribe(spy);
    (window as unknown as { dataLayer: unknown[] }).dataLayer.push(['consent', 'update', { analytics_storage: 'granted' }]);
    expect(spy).toHaveBeenCalled();
    expect(w.read()).toBe(true);
    stop();
  });
});

describe('custom sources', () => {
  it('a cookie equal to the value grants; the event is heard on window and document', () => {
    const w = consentWatcher({ cookie: 'bsm_consent', value: 'yes', event: 'consent-decided' });
    const spy = vi.fn();
    const stop = w.subscribe(spy);
    document.cookie = 'bsm_consent=yes; path=/';
    document.dispatchEvent(new Event('consent-decided'));
    window.dispatchEvent(new Event('consent-decided'));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(w.read()).toBe(true);
    stop();
  });
  it('server read of a check-based source is unknown (it can only run in the browser)', () => {
    expect(consentFromCookies({ check: () => true }, () => undefined)).toBeNull();
  });
});

describe('Shopify Customer Privacy (audit P0-10)', () => {
  type Priv = { analyticsProcessingAllowed: () => boolean; marketingAllowed: () => boolean };
  const setShopify = (v: unknown) => ((window as unknown as Record<string, unknown>).Shopify = v);

  it('is unknown until the API loads, then reads the API (which already applies region + merchant settings)', () => {
    const w = consentWatcher('shopify');
    expect(w.read()).toBeNull();
    let allowed = false;
    setShopify({ customerPrivacy: { analyticsProcessingAllowed: () => allowed, marketingAllowed: () => false } satisfies Priv });
    expect(w.read()).toBe(false);
    allowed = true;
    expect(w.read()).toBe(true);
    expect(consentWatcher({ cmp: 'shopify', category: 'marketing' }).read()).toBe(false);
  });

  it('loads the API through loadFeatures and re-reads on visitorConsentCollected', () => {
    let allowed = false;
    const loadFeatures = vi.fn((features: Array<{ name: string }>, cb: (err?: unknown) => void) => {
      expect(features[0]!.name).toBe('consent-tracking-api');
      (window as unknown as { Shopify: Record<string, unknown> }).Shopify.customerPrivacy = { analyticsProcessingAllowed: () => allowed };
      cb(false);
    });
    setShopify({ loadFeatures });
    const w = consentWatcher('shopify');
    const spy = vi.fn();
    const stop = w.subscribe(spy);
    expect(loadFeatures).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledOnce();
    expect(w.read()).toBe(false);
    allowed = true;
    document.dispatchEvent(new CustomEvent('visitorConsentCollected', { detail: { analyticsAllowed: true } }));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(w.read()).toBe(true);
    stop();
    document.dispatchEvent(new CustomEvent('visitorConsentCollected'));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('waits for a late Shopify global', () => {
    vi.useFakeTimers();
    const w = consentWatcher('shopify');
    const spy = vi.fn();
    const stop = w.subscribe(spy);
    vi.advanceTimersByTime(500);
    setShopify({ customerPrivacy: { analyticsProcessingAllowed: () => true } });
    vi.advanceTimersByTime(250);
    expect(spy).toHaveBeenCalledOnce();
    expect(w.read()).toBe(true);
    stop();
  });

  it('server read is unknown (the cookie format is undocumented)', () => {
    expect(consentFromCookies('shopify', () => 'anything')).toBeNull();
  });
});

describe('refused(): a recorded "no" (forget-me) vs merely gated (audit N2)', () => {
  it('Cookiebot: only an answered decline is a refusal — not-loaded and banner-pending are not', () => {
    const w = consentWatcher('cookiebot');
    expect(w.refused()).toBe(false);
    (window as unknown as Record<string, unknown>).Cookiebot = { consent: { statistics: false }, hasResponse: false };
    expect([w.read(), w.refused()]).toEqual([false, false]); // banner up
    (window as unknown as Record<string, unknown>).Cookiebot = { consent: { statistics: false }, hasResponse: true };
    expect(w.refused()).toBe(true);
  });
  it('OneTrust: default groups before an answer are not a refusal', () => {
    (window as unknown as Record<string, unknown>).OnetrustActiveGroups = ',C0001,';
    const w = consentWatcher('onetrust');
    expect([w.read(), w.refused()]).toEqual([false, false]);
    document.cookie = 'OptanonAlertBoxClosed=2026-09-25T10:00:00.000Z; path=/';
    expect(w.refused()).toBe(true);
  });
  it('CookieYes: only after the user acted', () => {
    (window as unknown as Record<string, unknown>).getCkyConsent = () => ({ categories: { analytics: false }, isUserActionCompleted: false });
    const w = consentWatcher('cookieyes');
    expect([w.read(), w.refused()]).toEqual([false, false]);
    (window as unknown as Record<string, unknown>).getCkyConsent = () => ({ categories: { analytics: false }, isUserActionCompleted: true });
    expect(w.refused()).toBe(true);
  });
  it('Shopify: "not allowed yet" is not a refusal; an explicit "no" is', () => {
    let answer = '';
    (window as unknown as Record<string, unknown>).Shopify = {
      customerPrivacy: { analyticsProcessingAllowed: () => false, currentVisitorConsent: () => ({ analytics: answer }) },
    };
    const w = consentWatcher('shopify');
    expect([w.read(), w.refused()]).toEqual([false, false]);
    answer = 'no';
    expect(w.refused()).toBe(true);
  });
  it('TCF: the banner being up gates but is not a refusal; a decision without the purposes is', () => {
    let listener: ((d: unknown, ok: boolean) => void) | undefined;
    (window as unknown as Record<string, unknown>).__tcfapi = (cmd: string, _v: number, cb: (d: unknown, ok: boolean) => void) => {
      if (cmd === 'addEventListener') listener = cb;
    };
    const w = consentWatcher('tcf');
    const stop = w.subscribe(() => undefined);
    listener!({ eventStatus: 'cmpuishown', gdprApplies: true }, true);
    expect([w.read(), w.refused()]).toEqual([false, false]);
    // Storage granted, profiling purposes absent (maybe never offered): gated, not forgotten.
    listener!({ eventStatus: 'useractioncomplete', gdprApplies: true, purpose: { consents: { 1: true } } }, true);
    expect([w.read(), w.refused()]).toEqual([false, false]);
    // Storage itself refused: forget.
    listener!({ eventStatus: 'useractioncomplete', gdprApplies: true, purpose: { consents: { 1: false } } }, true);
    expect([w.read(), w.refused()]).toEqual([false, true]);
    stop();
  });
  it('TCF publisher-segment consent counts (SentientUI processes for the site)', () => {
    let listener: ((d: unknown, ok: boolean) => void) | undefined;
    (window as unknown as Record<string, unknown>).__tcfapi = (cmd: string, _v: number, cb: (d: unknown, ok: boolean) => void) => {
      if (cmd === 'addEventListener') listener = cb;
    };
    const w = consentWatcher('tcf');
    const stop = w.subscribe(() => undefined);
    listener!({ eventStatus: 'tcloaded', gdprApplies: true, purpose: { consents: {} }, publisher: { consents: { 1: true, 5: true, 6: true, 8: true } } }, true);
    expect(w.read()).toBe(true);
    stop();
  });
  it('Consent Mode: a default is never a refusal (Google\'s setup pushes default: denied on every page); an update "denied" is', () => {
    (window as unknown as { dataLayer: unknown[] }).dataLayer = [['consent', 'default', { analytics_storage: 'denied' }]];
    expect([consentWatcher('google-consent-mode').read(), consentWatcher('google-consent-mode').refused()]).toEqual([false, false]);
    (window as unknown as { dataLayer: unknown[] }).dataLayer = [
      ['consent', 'default', { analytics_storage: 'granted' }],
      ['consent', 'default', { analytics_storage: 'denied', region: ['DE'] }],
    ];
    const w = consentWatcher('google-consent-mode');
    expect([w.read(), w.refused()]).toEqual([false, false]);
    expect(consentWatcher({ cmp: 'google-consent-mode', region: 'DE' }).refused()).toBe(false);
    (window as unknown as { dataLayer: unknown[] }).dataLayer.push(['consent', 'update', { analytics_storage: 'denied' }]);
    expect(w.refused()).toBe(true);
  });
  it('custom: another cookie value is a refusal; a check() never is', () => {
    document.cookie = 'my_consent=rejected; path=/';
    expect(consentWatcher({ cookie: 'my_consent', value: 'accepted' }).refused()).toBe(true);
    expect(consentWatcher({ check: () => false }).refused()).toBe(false);
  });
});

describe('Consent Mode — country-only region vs subdivision denial (review M2)', () => {
  it('region "US" with a US-CA denial reads denied (the visitor may be Californian)', () => {
    const dl = [
      ['consent', 'default', { analytics_storage: 'granted' }],
      ['consent', 'default', { analytics_storage: 'denied', region: ['US-CA'] }],
    ];
    expect(consentModeGranted(dl, 'analytics_storage', 'US')).toBe(false);
    expect(consentModeGranted(dl, 'analytics_storage', 'US-NY')).toBe(true);
    expect(consentModeGranted(dl, 'analytics_storage', 'GB')).toBe(true);
  });
});

describe('Consent Mode — an unsubscribed watcher goes quiet even when chained (review L2)', () => {
  it('gtag chaining onto our wrapper can\'t resurrect a stopped callback', () => {
    (window as unknown as { dataLayer: unknown[] }).dataLayer = [];
    const spy = vi.fn();
    const stop = consentWatcher('google-consent-mode').subscribe(spy);
    const dl = (window as unknown as { dataLayer: unknown[] & { push: (...a: unknown[]) => number } }).dataLayer;
    const prev = dl.push;
    dl.push = function (...a: unknown[]) {
      return prev.apply(dl, a);
    };
    stop();
    spy.mockClear();
    dl.push(['consent', 'update', { analytics_storage: 'granted' }]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('TCF publisher segment on the server (review L5)', () => {
  it('purposes recorded only in the publisher TC segment count, as they do in the browser', () => {
    const m = new TCModel(new GVL({ vendorListVersion: 1, tcfPolicyVersion: 4, lastUpdated: new Date('2026-01-01'), purposes: {}, specialPurposes: {}, features: {}, specialFeatures: {}, vendors: {}, stacks: {} } as never));
    m.cmpId = 10;
    m.cmpVersion = 1;
    m.publisherConsents.set([1, 5, 6, 8]);
    const tc = TCString.encode(m, { segments: ['core', 'publisherTC'] } as never);
    expect(tc.split('.').length).toBeGreaterThan(1);
    const c = tcStringConsents(tc)!;
    expect([...c.publisherPurposes].sort((a, b) => a - b)).toEqual([1, 5, 6, 8]);
    expect(c.purposes.size).toBe(0);
    expect(consentFromCookies('tcf', (n) => (n === 'euconsent-v2' ? tc : undefined))).toBe(true);
  });
});

describe('Cookiebot before uc.js has initialised (grader N-D)', () => {
  it('a returning visitor\'s stored grant wins over a default all-false consent object', () => {
    document.cookie = `CookieConsent=${encodeURIComponent("{stamp:'x',necessary:true,preferences:true,statistics:true,marketing:false}")}; path=/`;
    (window as unknown as Record<string, unknown>).Cookiebot = { consent: { statistics: false }, hasResponse: false };
    const w = consentWatcher('cookiebot');
    expect(w.read()).toBe(true);
    expect(w.refused()).toBe(false);
    // Once Cookiebot holds an answer in memory (e.g. withdrawn this page view), it wins.
    (window as unknown as Record<string, unknown>).Cookiebot = { consent: { statistics: false }, hasResponse: true };
    expect(w.read()).toBe(false);
  });
});

describe('custom check source with refused (grader F4)', () => {
  it('a check source forgets only when the site says the visitor refused', () => {
    let answered = false;
    const w = consentWatcher({ check: () => false, refused: () => answered });
    expect([w.read(), w.refused()]).toEqual([false, false]);
    answered = true;
    expect(w.refused()).toBe(true);
    expect(consentWatcher({ check: () => false, refused: () => { throw new Error('x'); } }).refused()).toBe(false);
  });
});

describe('regrade 7', () => {
  it('N7-1: an encoded groups=… inside landingPath is not consent', () => {
    const cookie = `isGpcEnabled=0&datestamp=x&version=6.0&landingPath=${encodeURIComponent('https://shop.example/?x=1&groups=C0002:1')}&AwaitingReconsent=false`;
    expect(onetrustCookieGrants(cookie)).toBeNull();
    const answered = `${cookie}&groups=${encodeURIComponent('C0001:1,C0002:0')}`;
    expect(onetrustCookieGrants(answered)).toBe(false);
    expect(onetrustCookieGrants(`groups=${encodeURIComponent('C0001:1,C0002:1')}&landingPath=NotLandingPage`)).toBe(true);

  });

  it('R8 NEW-1: an already-decoded cookie (Next cookies()) still reads the real groups', () => {
    const encoded = `isGpcEnabled=0&landingPath=${encodeURIComponent('https://shop.example/?x=1&groups=C0002:1')}&groups=${encodeURIComponent('C0001:1,C0002:0')}`;
    expect(onetrustCookieGrants(decodeURIComponent(encoded))).toBe(false);
  });

  it('N7-5 / N7-8: TCF loading callbacks read unknown; purposeOneTreatment can be granted', () => {
    let listener: ((d: unknown, ok: boolean) => void) | undefined;
    (window as unknown as Record<string, unknown>).__tcfapi = (cmd: string, _v: number, cb: (d: unknown, ok: boolean) => void) => {
      if (cmd === 'addEventListener') listener = cb;
    };
    const w = consentWatcher('tcf');
    const stop = w.subscribe(() => undefined);
    listener!({ cmpStatus: 'loading', gdprApplies: true }, true);
    expect(w.read()).toBeNull();
    listener!({ eventStatus: 'tcloaded', gdprApplies: true, purposeOneTreatment: true, purpose: { consents: { 5: true, 6: true, 8: true } } }, true);
    expect([w.read(), w.refused()]).toEqual([true, false]);
    // After a decision a stray loading callback changes nothing: the SDKs read
    // null-after-an-answer as a pause (review R11 #2).
    listener!({ cmpStatus: 'loading', gdprApplies: true }, true);
    expect(w.read()).toBe(true);
    stop();
  });
});
