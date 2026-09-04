import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readCachedEditorToken, cacheEditorToken, clearCachedEditorToken } from './editor-token';

const EDITOR_TOKEN_KEY = '__snt_editor_token';

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as { __sentientEditor?: unknown }).__sentientEditor;
});

describe('editor token cache', () => {
  it('round-trips a token through sessionStorage', () => {
    expect(readCachedEditorToken()).toBeNull();
    cacheEditorToken('tok_abc');
    expect(readCachedEditorToken()).toBe('tok_abc');
    expect(sessionStorage.getItem(EDITOR_TOKEN_KEY)).toBe('tok_abc');
  });

  it('clear actually removes the sessionStorage entry, not just the read view', () => {
    // The token lives for the whole tab session: if clear only masked the value
    // (or silently failed), a rejected 401 token would re-enter editor mode on
    // every reload of this tab, forever.
    cacheEditorToken('tok_stale');
    clearCachedEditorToken();
    expect(sessionStorage.getItem(EDITOR_TOKEN_KEY)).toBeNull();
    expect(readCachedEditorToken()).toBeNull();
  });

  it('behaves as uncached and never throws when storage access is disabled', () => {
    // Safari private mode / partitioned storage / storage-blocked embeds make
    // every Storage call throw. The snippet runs on customer pages — a throw
    // here would abort the whole snippet, not just the editor convenience.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(readCachedEditorToken()).toBeNull();
    expect(() => cacheEditorToken('tok')).not.toThrow();
    expect(() => clearCachedEditorToken()).not.toThrow();
  });
});

describe('editor 401 path', () => {
  it('a 401 on verify clears the cached token so a reload cannot re-open the dead session', async () => {
    // The regression this prevents: the editor rejected the bearer token (401)
    // but left it in sessionStorage, so every reload of the tab silently
    // re-entered editor mode with the same dead credential for the tab's life.
    cacheEditorToken('tok_expired');
    (window as unknown as { __sentientEditor?: unknown }).__sentientEditor = {
      token: 'tok_expired',
      apiBase: 'https://api.example.com',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401, ok: false }));

    // The editor bundle runs start() at import time (it is loaded on demand by
    // the snippet); resetModules so this import re-executes it.
    vi.resetModules();
    await import('./editor/index');

    await vi.waitFor(() => {
      expect(sessionStorage.getItem(EDITOR_TOKEN_KEY)).toBeNull();
    });
    // And the user is told why, instead of a silent blank page.
    expect(document.getElementById('sentient-editor-toast')?.textContent).toContain('expired');
  });
});
