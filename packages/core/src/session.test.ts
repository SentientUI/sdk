import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initSession } from './session';

// The existing "never throws when both storage mechanisms fail" test redefines
// document.cookie with a throwing getter/setter via Object.defineProperty and does
// not restore it (vi.unstubAllGlobals does not undo defineProperty). That broken
// descriptor leaks into later describe blocks. Capture the original descriptor at
// module load and provide a restore helper so the new suites start clean.
const ORIGINAL_COOKIE_DESCRIPTOR =
  Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ??
  Object.getOwnPropertyDescriptor(document, 'cookie');

function restoreNativeCookie(): void {
  if (ORIGINAL_COOKIE_DESCRIPTOR) {
    // Remove any per-instance override on `document`, then ensure the prototype
    // descriptor is in place so the real jsdom cookie jar is used again.
    delete (document as unknown as { cookie?: unknown }).cookie;
    Object.defineProperty(Document.prototype, 'cookie', ORIGINAL_COOKIE_DESCRIPTOR);
  }
}

describe('initSession', () => {
  beforeEach(() => {
    document.cookie = '';
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates new session ID when no storage exists', () => {
    const manager = initSession();
    const id = manager.getSessionId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
    expect(document.cookie).toContain('_snt_uid=');
    expect(localStorage.getItem('_snt_uid')).toBe(id);
  });

  it('namespaces the visitor id per project so two keys on one origin do not collide', () => {
    // apiKeys < 12 chars so slice(0,12) is the whole key (stable assertion).
    const a = initSession({ apiKey: 'pk_projectA' }).getSessionId();
    const b = initSession({ apiKey: 'pk_projectB' }).getSessionId();
    // Different projects → different namespaced keys → independent ids.
    expect(a).not.toBe(b);
    expect(localStorage.getItem('_snt_uid_pk_projectA')).toBe(a);
    expect(localStorage.getItem('_snt_uid_pk_projectB')).toBe(b);
    // The legacy unprefixed key is never written when an apiKey is supplied.
    expect(localStorage.getItem('_snt_uid')).toBeNull();
    // Re-init for the same project restores the same id.
    expect(initSession({ apiKey: 'pk_projectA' }).getSessionId()).toBe(a);
  });

  it('generates a valid RFC4122 v4 session ID when crypto.randomUUID is unavailable', () => {
    // Insecure context (plain http:// non-localhost): Web Crypto is absent, so
    // the generator must still produce a spec-valid UUID — the sessions/goals/
    // events endpoints store it in a Postgres `uuid` column and reject anything
    // malformed with `invalid input syntax for type uuid`.
    document.cookie = '_snt_uid=; max-age=0; path=/';
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('crypto', {});

    const id = initSession().getSessionId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('restores session ID from cookie on reinit', () => {
    document.cookie = '_snt_uid=existing-cookie-id; path=/';
    const manager = initSession();
    expect(manager.getSessionId()).toBe('existing-cookie-id');
  });

  it('falls back to localStorage when cookie unavailable', () => {
    document.cookie = '_snt_uid=; max-age=0; path=/';
    localStorage.setItem('_snt_uid', 'stored-id');
    const manager = initSession();
    expect(manager.getSessionId()).toBe('stored-id');
  });

  it('returns null when window is undefined', () => {
    vi.stubGlobal('window', undefined);
    const manager = initSession();
    expect(manager.getSessionId()).toBeNull();
    expect(() => manager.destroy()).not.toThrow();
  });

  it('falls back to sessionStorage when localStorage fails', () => {
    sessionStorage.clear();
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    });

    const manager = initSession();
    const id = manager.getSessionId();
    expect(id).toBeTruthy();
    expect(sessionStorage.getItem('_snt_uid')).toBe(id);
    expect(manager.isEphemeral()).toBe(false);
  });

  it('destroy clears sessionId, cookie, localStorage, and sessionStorage', () => {
    const manager = initSession();
    const id = manager.getSessionId();
    expect(id).toBeTruthy();

    manager.destroy();

    expect(manager.getSessionId()).toBeNull();
    expect(document.cookie).not.toContain('_snt_uid=');
    expect(localStorage.getItem('_snt_uid')).toBeNull();
    expect(sessionStorage.getItem('_snt_uid')).toBeNull();
  });

  it('adopts ssrSessionId when no storage exists', () => {
    const manager = initSession({ ssrSessionId: 'ssr-session-abc' });
    expect(manager.getSessionId()).toBe('ssr-session-abc');
    expect(localStorage.getItem('_snt_uid')).toBe('ssr-session-abc');
    expect(document.cookie).toContain('_snt_uid=ssr-session-abc');
  });

  it('ignores ssrSessionId when cookie already exists', () => {
    document.cookie = '_snt_uid=existing-id; path=/';
    const manager = initSession({ ssrSessionId: 'ssr-session-abc' });
    expect(manager.getSessionId()).toBe('existing-id');
  });

  it('ignores ssrSessionId when localStorage already has a value', () => {
    document.cookie = '_snt_uid=; max-age=0; path=/';
    localStorage.setItem('_snt_uid', 'stored-id');
    const manager = initSession({ ssrSessionId: 'ssr-session-abc' });
    expect(manager.getSessionId()).toBe('stored-id');
  });

  it('never throws when both storage mechanisms fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('quota');
    });
    Object.defineProperty(document, 'cookie', {
      get: () => {
        throw new Error('cookie blocked');
      },
      set: () => {
        throw new Error('cookie blocked');
      },
      configurable: true,
    });

    expect(() => initSession()).not.toThrow();
    const manager = initSession();
    expect(manager.getSessionId()).toBeTruthy();
  });
});

describe('initSession — 3-layer fallback chain', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    restoreNativeCookie();
    localStorage.clear();
    sessionStorage.clear();
    document.cookie = '_snt_uid=; max-age=0; path=/';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('cookie wins over localStorage and sessionStorage', () => {
    document.cookie = '_snt_uid=cookie-id; path=/';
    localStorage.setItem('_snt_uid', 'ls-id');
    sessionStorage.setItem('_snt_uid', 'ss-id');
    const manager = initSession();
    expect(manager.getSessionId()).toBe('cookie-id');
    // Cookie writable and localStorage writable → not ephemeral.
    expect(manager.isEphemeral()).toBe(false);
  });

  it('localStorage wins over sessionStorage when cookie is absent', () => {
    document.cookie = '_snt_uid=; max-age=0; path=/';
    localStorage.setItem('_snt_uid', 'ls-id');
    sessionStorage.setItem('_snt_uid', 'ss-id');
    const manager = initSession();
    expect(manager.getSessionId()).toBe('ls-id');
    expect(manager.isEphemeral()).toBe(false);
  });

  it('reads from sessionStorage when cookie and localStorage are both empty', () => {
    document.cookie = '_snt_uid=; max-age=0; path=/';
    // localStorage getItem returns null; sessionStorage holds the id.
    sessionStorage.setItem('_snt_uid', 'ss-only-id');
    const manager = initSession();
    expect(manager.getSessionId()).toBe('ss-only-id');
  });

  it('cookie readable but localStorage write throws — id from cookie, not ephemeral (cookie ok)', () => {
    document.cookie = '_snt_uid=cookie-id; path=/';
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage) {
      // Only localStorage.setItem throws; sessionStorage is a different instance
      // but Storage.prototype is shared, so guard by the store identity.
      if (this === localStorage) throw new Error('quota');
      // sessionStorage write succeeds
      return undefined as unknown as void;
    });

    const manager = initSession();
    expect(manager.getSessionId()).toBe('cookie-id');
    // lsOk=false, but probeCookieWritable should pass (real jsdom cookie) → not ephemeral.
    expect(manager.isEphemeral()).toBe(false);
  });

  it('cookie blocked AND localStorage throws but sessionStorage works → not ephemeral, ssOk path', () => {
    // Block cookie entirely.
    Object.defineProperty(document, 'cookie', {
      get: () => '',
      set: () => { throw new Error('cookie blocked'); },
      configurable: true,
    });
    // localStorage throws on write and reads as empty; sessionStorage works normally.
    const realSessionSet = sessionStorage.setItem.bind(sessionStorage);
    const realSessionGet = sessionStorage.getItem.bind(sessionStorage);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
      if (this === localStorage) return null;
      return realSessionGet(k);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (this === localStorage) throw new Error('quota');
      realSessionSet(k, v);
    });

    const manager = initSession();
    const id = manager.getSessionId();
    expect(id).toBeTruthy();
    // lsOk=false, cookieOk=false, ssOk=true → ephemeral is false.
    expect(manager.isEphemeral()).toBe(false);
    expect(sessionStorage.getItem('_snt_uid')).toBe(id);
  });

  it('all three layers fail → ephemeral true, id still in memory', () => {
    Object.defineProperty(document, 'cookie', {
      get: () => '',
      set: () => { throw new Error('cookie blocked'); },
      configurable: true,
    });
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });

    const manager = initSession();
    expect(manager.getSessionId()).toBeTruthy();
    expect(manager.isEphemeral()).toBe(true);
  });
});

describe('readCookie regex edge cases (via initSession restore)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    restoreNativeCookie();
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    restoreNativeCookie();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads the first matching cookie when a duplicate name appears later in the string', () => {
    // jsdom merges document.cookie; emulate a raw header with a duplicate name.
    Object.defineProperty(document, 'cookie', {
      get: () => 'other=1; _snt_uid=first-value; _snt_uid=second-value',
      set: () => {},
      configurable: true,
    });
    const manager = initSession();
    // Regex `(?:^|; )_snt_uid=([^;]*)` matches the first occurrence.
    expect(manager.getSessionId()).toBe('first-value');
  });

  it('does NOT match a name that is only a suffix of another cookie key', () => {
    // `x_snt_uid=decoy` must not satisfy the `(?:^|; )_snt_uid=` boundary; the real
    // cookie comes after. Without the boundary this would wrongly match 'decoy'.
    Object.defineProperty(document, 'cookie', {
      get: () => 'x_snt_uid=decoy; _snt_uid=real-value',
      set: () => {},
      configurable: true,
    });
    const manager = initSession();
    expect(manager.getSessionId()).toBe('real-value');
  });

  it('empty cookie value falls through to localStorage', () => {
    Object.defineProperty(document, 'cookie', {
      get: () => '_snt_uid=',
      set: () => {},
      configurable: true,
    });
    localStorage.setItem('_snt_uid', 'ls-fallback');
    const manager = initSession();
    // A `_snt_uid=` empty cookie is treated as absent (not a real id), so the
    // chain falls through to the localStorage layer rather than adopting ''.
    expect(manager.getSessionId()).toBe('ls-fallback');
  });

  it('empty cookie with no stored id regenerates a valid session id', () => {
    // Empty cookie AND no localStorage/sessionStorage entry: the visitor must not
    // be locked into a falsy '' id (which would mute every track/goal/upsert).
    // '' is treated as absent so a fresh RFC 4122 v4 id is generated.
    Object.defineProperty(document, 'cookie', {
      get: () => '_snt_uid=',
      set: () => {},
      configurable: true,
    });
    const manager = initSession();
    const id = manager.getSessionId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('malformed percent-encoding in cookie value → readCookie returns null, falls through', () => {
    // decodeURIComponent('%') throws URIError; readCookie catches → returns null.
    Object.defineProperty(document, 'cookie', {
      get: () => '_snt_uid=%E0%A4%A',
      set: () => {},
      configurable: true,
    });
    localStorage.setItem('_snt_uid', 'ls-after-bad-cookie');
    const manager = initSession();
    expect(manager.getSessionId()).toBe('ls-after-bad-cookie');
  });
});

describe('post-destroy consistency', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    restoreNativeCookie();
    localStorage.clear();
    sessionStorage.clear();
    document.cookie = '_snt_uid=; max-age=0; path=/';
  });
  afterEach(() => {
    restoreNativeCookie();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('getSessionId() stays null after destroy() across repeated calls', () => {
    const manager = initSession();
    expect(manager.getSessionId()).toBeTruthy();
    manager.destroy();
    expect(manager.getSessionId()).toBeNull();
    expect(manager.getSessionId()).toBeNull();
  });

  it('destroy() is idempotent and never throws on a second call', () => {
    const manager = initSession();
    manager.destroy();
    expect(() => manager.destroy()).not.toThrow();
    expect(manager.getSessionId()).toBeNull();
  });

  it('a fresh initSession after destroy generates a new id (old storage cleared)', () => {
    const m1 = initSession();
    const firstId = m1.getSessionId();
    m1.destroy();

    const m2 = initSession();
    const secondId = m2.getSessionId();
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
  });
});
