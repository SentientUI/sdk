import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '@shopify/shopify-app-remix/server';
import { EncryptedSessionStorage, type SessionStorageLike } from './session-storage.server';

// Session tokens are Admin API access to the merchant's store — the same
// database whose stored sk_ justified envelope encryption held these in
// plaintext. The wrapper must encrypt on store, decrypt on load, leave legacy
// plaintext rows readable, and NEVER hand ciphertext back as a bearer token.

const KEY = 'a-test-passphrase-long-enough-to-count';

afterEach(() => {
  delete process.env.SETTINGS_ENCRYPTION_KEY;
  vi.restoreAllMocks();
});

/** In-memory delegate standing in for PrismaSessionStorage: stores whatever
 *  Session objects it is handed, returns them as-is. */
function fakeDelegate() {
  const rows = new Map<string, Session>();
  const delegate: SessionStorageLike = {
    async storeSession(s) { rows.set(s.id, s); return true; },
    async loadSession(id) { return rows.get(id); },
    async deleteSession(id) { rows.delete(id); return true; },
    async deleteSessions(ids) { ids.forEach((id) => rows.delete(id)); return true; },
    async findSessionsByShop(shop) { return [...rows.values()].filter((s) => s.shop === shop); },
  };
  return { rows, delegate };
}

function makeSession(overrides: Partial<{ accessToken: string; refreshToken: string }> = {}) {
  return new Session({
    id: 'offline_x.myshopify.com',
    shop: 'x.myshopify.com',
    state: 'state',
    isOnline: false,
    accessToken: 'shpat_secret_token',
    refreshToken: 'refresh_secret',
    ...overrides,
  });
}

describe('EncryptedSessionStorage', () => {
  it('stores tokens enveloped, never in the clear', async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    const { rows, delegate } = fakeDelegate();
    const storage = new EncryptedSessionStorage(delegate);
    await storage.storeSession(makeSession());
    const stored = rows.get('offline_x.myshopify.com')!;
    expect(stored.accessToken).not.toContain('shpat_secret_token');
    expect(stored.accessToken!.startsWith('v1:')).toBe(true);
    expect(stored.refreshToken!.startsWith('v1:')).toBe(true);
  });

  it('does not mutate the caller session — the runtime keeps using it for Admin API calls', async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    const { delegate } = fakeDelegate();
    const session = makeSession();
    await new EncryptedSessionStorage(delegate).storeSession(session);
    // Encrypting in place would hand ciphertext to the next GraphQL call
    // within the same request and 401 it.
    expect(session.accessToken).toBe('shpat_secret_token');
    expect(session.refreshToken).toBe('refresh_secret');
  });

  it('round-trips through load and findSessionsByShop', async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    const { delegate } = fakeDelegate();
    const storage = new EncryptedSessionStorage(delegate);
    await storage.storeSession(makeSession());
    const loaded = await storage.loadSession('offline_x.myshopify.com');
    expect(loaded?.accessToken).toBe('shpat_secret_token');
    expect(loaded?.refreshToken).toBe('refresh_secret');
    const byShop = await storage.findSessionsByShop('x.myshopify.com');
    expect(byShop).toHaveLength(1);
    expect(byShop[0]!.accessToken).toBe('shpat_secret_token');
  });

  it('reads a legacy plaintext row unchanged — lazy migration, no flag day', async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    const { rows, delegate } = fakeDelegate();
    // Written by PrismaSessionStorage before the wrapper existed.
    rows.set('offline_x.myshopify.com', makeSession());
    const loaded = await new EncryptedSessionStorage(delegate).loadSession('offline_x.myshopify.com');
    expect(loaded?.accessToken).toBe('shpat_secret_token');
  });

  it('stores the tokenless OAuth state session without inventing an envelope', async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    const { rows, delegate } = fakeDelegate();
    // The OAuth begin step stores a session BEFORE any token exists.
    const bare = new Session({ id: 'state-only', shop: 'x.myshopify.com', state: 's', isOnline: false });
    await new EncryptedSessionStorage(delegate).storeSession(bare);
    expect(rows.get('state-only')!.accessToken).toBeUndefined();
  });

  it('degrades to plaintext when no key is configured, exactly like secret-box', async () => {
    const { rows, delegate } = fakeDelegate();
    const storage = new EncryptedSessionStorage(delegate);
    await storage.storeSession(makeSession());
    expect(rows.get('offline_x.myshopify.com')!.accessToken).toBe('shpat_secret_token');
    expect((await storage.loadSession('offline_x.myshopify.com'))?.accessToken).toBe('shpat_secret_token');
  });

  it('treats an undecryptable row as logged out instead of returning ciphertext', async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    const { delegate } = fakeDelegate();
    const storage = new EncryptedSessionStorage(delegate);
    await storage.storeSession(makeSession());
    // The operator rotates the key: the stored envelope no longer opens.
    process.env.SETTINGS_ENCRYPTION_KEY = 'a-DIFFERENT-passphrase-also-long-enough';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Returning the ciphertext would send it as a bearer token (confusing
    // 401s); throwing would 500 every embedded request. "No session" lets the
    // token-exchange strategy mint a fresh one and re-encrypt under the new key.
    expect(await storage.loadSession('offline_x.myshopify.com')).toBeUndefined();
    expect(await storage.findSessionsByShop('x.myshopify.com')).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('SETTINGS_ENCRYPTION_KEY'));
  });
});
