/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://app.example.com/pricing" }
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parentDomains } from './cookie-domain.js';
import { initSession } from './session.js';
import { forgetVisitor } from './forget.js';
import { detectTrafficSource } from './session-meta.js';
import { sessionCookieName } from './storage-key.js';

// jsdom's cookie jar enforces domain matching and the public-suffix list like
// a browser does, so the shared-cookie behaviour runs for real here: a page on
// app.example.com, sharing its visitor with example.com.
const KEY = 'pk_live_abcdef123456';
const NAME = sessionCookieName(KEY);
const SECURE = '; Secure';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function values(name: string): string[] {
  return document.cookie
    .split('; ')
    .filter((c) => c.startsWith(`${name}=`))
    .map((c) => decodeURIComponent(c.slice(name.length + 1)));
}
function setHostOnly(value: string): void {
  document.cookie = `${NAME}=${value}; max-age=3600; path=/; SameSite=lax${SECURE}`;
}
function setShared(value: string): void {
  document.cookie = `${NAME}=${value}; max-age=3600; path=/; domain=example.com; SameSite=lax${SECURE}`;
}
function clearAll(): void {
  for (const d of ['', '; domain=example.com']) {
    document.cookie = `${NAME}=; max-age=0; path=/${d}${SECURE}`;
  }
}

beforeEach(() => {
  clearAll();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => clearAll());

describe('parentDomains', () => {
  it('lists candidates shortest first, ending with the host itself', () => {
    expect(parentDomains('a.b.example.co.uk')).toEqual(['co.uk', 'example.co.uk', 'b.example.co.uk', 'a.b.example.co.uk']);
    expect(parentDomains('app.example.com')).toEqual(['example.com', 'app.example.com']);
    // The bare domain shares on itself — the landing page of a landing → app journey.
    expect(parentDomains('example.com')).toEqual(['example.com']);
  });

  it('has nothing to share on localhost, an intranet name or an IP', () => {
    expect(parentDomains('localhost')).toEqual([]);
    expect(parentDomains('intranet')).toEqual([]);
    expect(parentDomains('10.0.0.12')).toEqual([]);
    expect(parentDomains('[::1]')).toEqual([]);
  });
});

describe('cookie domain detection', () => {
  it('auto-detects the registrable domain (the browser refuses the public suffix)', () => {
    expect(initSession({ apiKey: KEY }).domain).toBe('example.com');
    // The probe leaves nothing behind.
    expect(document.cookie).not.toContain(`${NAME}_dom`);
  });

  it('false keeps the cookie on this host; a string is used only when it covers the host', () => {
    expect(initSession({ apiKey: KEY, cookieDomain: false }).domain).toBeNull();
    clearAll();
    expect(initSession({ apiKey: KEY, cookieDomain: '.example.com' }).domain).toBe('example.com');
    clearAll();
    // The browser refuses a domain that doesn't cover the host; the id must
    // still persist, host-only, rather than be lost.
    const s = initSession({ apiKey: KEY, cookieDomain: 'other.com' });
    expect(s.domain).toBeNull();
    expect(values(NAME)).toEqual([s.getSessionId()]);
  });
});

describe('shared visitor cookie', () => {
  it('writes the visitor id on the shared domain, so a sibling host reads the same id', () => {
    const id = initSession({ apiKey: KEY }).getSessionId();
    // One cookie, readable from example.com and every subdomain.
    expect(values(NAME)).toEqual([id]);
    // A host-only delete leaves it: it lives on example.com, not on this host.
    document.cookie = `${NAME}=; max-age=0; path=/${SECURE}`;
    expect(values(NAME)).toEqual([id]);
  });

  it('aligns two ids: the shared cookie wins over this host’s own cookie and storage', () => {
    // app.example.com minted B before sharing existed; example.com has since
    // written A on the shared domain.
    setHostOnly(B);
    localStorage.setItem(`_snt_uid_${KEY.slice(0, 12)}`, B);
    setShared(A);
    expect(values(NAME).sort()).toEqual([A, B].sort());

    const session = initSession({ apiKey: KEY });
    expect(session.getSessionId()).toBe(A);
    // The host-only copy is gone, and storage follows the shared id.
    expect(values(NAME)).toEqual([A]);
    expect(localStorage.getItem(`_snt_uid_${KEY.slice(0, 12)}`)).toBe(A);
  });

  it('promotes this host’s existing id to the shared domain when there is no shared id yet', () => {
    setHostOnly(B);
    expect(initSession({ apiKey: KEY }).getSessionId()).toBe(B);
    expect(values(NAME)).toEqual([B]);
    // It is the shared copy now: deleting the host-only cookie leaves it.
    document.cookie = `${NAME}=; max-age=0; path=/${SECURE}`;
    expect(values(NAME)).toEqual([B]);
  });

  it('cookieDomain: false keeps the old host-only behaviour', () => {
    const id = initSession({ apiKey: KEY, cookieDomain: false }).getSessionId();
    expect(values(NAME)).toEqual([id]);
    document.cookie = `${NAME}=; max-age=0; path=/${SECURE}`; // host-only delete
    expect(values(NAME)).toEqual([]);
  });

  it('forget-me clears the shared copy too, so no sibling host re-adopts it', () => {
    setShared(A);
    expect(forgetVisitor(KEY)).toBe(true);
    expect(values(NAME)).toEqual([]);
  });

  it('destroy() clears both copies', () => {
    const session = initSession({ apiKey: KEY });
    session.destroy();
    expect(values(NAME)).toEqual([]);
  });
});

describe('detectTrafficSource across the site’s hosts', () => {
  it('a hop between hosts of the shared domain is internal, not a referral', () => {
    expect(detectTrafficSource('https://example.com/pricing', 'https://app.example.com', 'example.com')).toBe('direct');
    expect(detectTrafficSource('https://www.example.com/', 'https://app.example.com', 'example.com')).toBe('direct');
    expect(detectTrafficSource('https://notexample.com/', 'https://app.example.com', 'example.com')).toBe('referral');
    expect(detectTrafficSource('https://example.com/', 'https://app.example.com', null)).toBe('referral');
  });
});
