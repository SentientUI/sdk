import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { editorSession, editorSessionActive, resetEditorSessionForTests } from './editor-session.js';
import { maybeStartCellPreview, takeRegionRefresh, submitRegionRefresh } from './cell-preview.js';

// E1 on React sites: the dashboard sends a one-time code in the fragment; the
// SDK must exchange it exactly once however many features ask, keep a hash
// route intact (E2), and never act on a bare URL param without a session.
describe('editorSession', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetEditorSessionForTests();
    sessionStorage.clear();
    document.getElementById('sentient-cell-preview-bar')?.remove();
    fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith('/editor/exchange')
        ? { ok: true, status: 200, json: async () => ({ token: 'tok' }) }
        : { ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('exchanges once for every caller, caches the token, restores the hash route', async () => {
    window.history.replaceState(null, '', '/?a=1#/shop?sentient_editor_code=c.sig');
    const [a, b] = await Promise.all([editorSession('https://api.x/v1'), editorSession('https://api.x/v1')]);
    expect(a).toEqual({ token: 'tok', fresh: true });
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ code: 'c.sig' });
    expect(window.location.hash).toBe('#/shop');
    expect(window.location.search).toBe('?a=1');
    expect(sessionStorage.getItem('__snt_editor_token')).toBe('tok');
  });

  it('a refused code reports its status and caches nothing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    window.history.replaceState(null, '', '/#sentient_editor_code=c.sig');
    expect(await editorSession('https://api.x/v1')).toEqual({ error: 401 });
    expect(sessionStorage.getItem('__snt_editor_token')).toBeNull();
  });

  it('a refresh param with no session does nothing (a visitor, not an operator)', () => {
    window.history.replaceState(null, '', '/?sentient_refresh_region=hero');
    maybeStartCellPreview('https://api.x/v1');
    expect(editorSessionActive()).toBe(false);
    expect(takeRegionRefresh('hero')).toBeNull();
  });

  it('region refresh posts with the exchanged token even when the slot takes it before the exchange lands', async () => {
    window.history.replaceState(null, '', '/?sentient_refresh_region=hero#sentient_editor_code=c.sig');
    maybeStartCellPreview('https://api.x/v1');
    const r = takeRegionRefresh('hero');
    expect(r).not.toBeNull();
    submitRegionRefresh(r!, { skeleton: null });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('https://api.x/v1/editor/region-skeleton');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok' });
  });
});
