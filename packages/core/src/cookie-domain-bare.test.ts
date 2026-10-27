/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://example.com/" }
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSession } from './session.js';
import { forgetVisitor } from './forget.js';
import { sessionCookieName } from './storage-key.js';

// The landing page of a landing → app journey usually lives on the BARE
// domain. It must share on itself (Domain=example.com); a review caught it
// staying host-only while app.example.com shared, so the journey was still two
// visitors and forget-me here left the shared copy behind.
const KEY = 'pk_live_bare12345678';
const NAME = sessionCookieName(KEY);
const SECURE = '; Secure';
const APP_ID = '33333333-3333-4333-8333-333333333333';
const OWN_ID = '44444444-4444-4444-8444-444444444444';

const values = (): string[] =>
  document.cookie.split('; ').filter((c) => c.startsWith(`${NAME}=`)).map((c) => decodeURIComponent(c.slice(NAME.length + 1)));
const clearAll = (): void => {
  for (const d of ['', '; domain=example.com']) document.cookie = `${NAME}=; max-age=0; path=/${d}${SECURE}`;
};

beforeEach(() => {
  clearAll();
  localStorage.clear();
});
afterEach(() => clearAll());

describe('shared visitor cookie on the bare domain', () => {
  it('shares on the bare domain itself', () => {
    const s = initSession({ apiKey: KEY });
    expect(s.domain).toBe('example.com');
    // (Not asserted via a host-only delete: jsdom's jar keys a host-only and a
    // Domain= cookie on the bare domain as ONE slot, Chrome as two — either
    // way the session ends with one cookie holding this id.)
    expect(values()).toEqual([s.getSessionId()]);
  });

  it('adopts the id the app subdomain shared, over this host’s own', () => {
    document.cookie = `${NAME}=${OWN_ID}; max-age=3600; path=/; SameSite=lax${SECURE}`;
    // What app.example.com writes (domain=example.com reaches the bare domain too).
    document.cookie = `${NAME}=${APP_ID}; max-age=3600; path=/; domain=example.com; SameSite=lax${SECURE}`;
    expect(initSession({ apiKey: KEY }).getSessionId()).toBe(APP_ID);
    expect(values()).toEqual([APP_ID]);
  });

  it('forget-me clears the shared copy here too', () => {
    document.cookie = `${NAME}=${APP_ID}; max-age=3600; path=/; domain=example.com; SameSite=lax${SECURE}`;
    forgetVisitor(KEY);
    expect(values()).toEqual([]);
  });
});
