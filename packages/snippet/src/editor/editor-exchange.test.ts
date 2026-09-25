import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// E1: the snippet hands the editor a one-time fragment code, never a token.
// The editor must trade it (POST, once) for the token BEFORE anything else,
// cache the token (a reload cannot reuse the spent code), and treat a refused
// code as "reopen from the dashboard".
type G = { __sentientEditor?: { token?: string | null; code?: string | null; apiBase: string } | null };

describe('editor boot: one-time code exchange', () => {
  beforeEach(() => {
    document.body.innerHTML = '<h1 id="h">Hi</h1>';
    vi.resetModules();
    sessionStorage.clear();
    (window as unknown as G).__sentientEditor = { token: null, code: 'c.sig', apiBase: 'https://api.example.com' };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('POSTs the code, then verifies and mounts with the exchanged token, which it caches', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/v1/editor/exchange')) return new Response(JSON.stringify({ token: 'real.tok' }), { status: 200 });
      if (url.endsWith('/v1/editor/verify')) return new Response(JSON.stringify({ projectId: 'p1' }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    await import('./index');
    await vi.waitFor(() => expect(document.getElementById('sentient-editor-panel')).not.toBeNull());
    expect(calls[0]!.url).toBe('https://api.example.com/v1/editor/exchange');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ code: 'c.sig' });
    // The code never becomes a bearer credential.
    expect(new Headers(calls[1]!.init?.headers).get('authorization')).toBe('Bearer real.tok');
    expect(sessionStorage.getItem('__snt_editor_token')).toBe('real.tok');
    expect((window as unknown as G).__sentientEditor?.code ?? null).toBeNull();
  });

  it('an expired or already-used code (401) shows the reopen notice and never verifies or mounts', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"code_already_used"}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await import('./index');
    await vi.waitFor(() => expect(document.getElementById('sentient-editor-toast')).not.toBeNull());
    expect(document.getElementById('sentient-editor-toast')!.textContent).toContain('expired');
    expect(document.getElementById('sentient-editor-panel')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('__snt_editor_token')).toBeNull();
  });

  it('a refused origin (403) is a load error, not "expired"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"origin_not_allowed"}', { status: 403 })));
    await import('./index');
    await vi.waitFor(() => expect(document.getElementById('sentient-editor-toast')).not.toBeNull());
    expect(document.getElementById('sentient-editor-toast')!.textContent).not.toContain('expired');
  });
});
