import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@sentientui/core/style-sample', () => ({ sampleStyleVocabulary: () => ({ entries: [], images: [] }) }));
const { maybeCaptureStyles, resetStyleCaptureForTests } = await import('./style-capture.js');

describe('maybeCaptureStyles (fresh editor sessions only)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    resetStyleCaptureForTests();
    sessionStorage.clear();
    fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith('/editor/exchange')
        ? { ok: true, status: 200, json: async () => ({ token: 'tok' }) }
        : { ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
    vi.useRealTimers();
    sessionStorage.clear();
  });

  it('exchanges the fragment code once, then posts the sample with the exchanged token', async () => {
    window.history.replaceState(null, '', '/#sentient_editor_code=c.sig');
    maybeCaptureStyles('https://api.example.com/v1');
    maybeCaptureStyles('https://api.example.com/v1');
    await vi.advanceTimersByTimeAsync(1100);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example.com/v1/editor/exchange');
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('https://api.example.com/v1/editor/style-vocabulary');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok' });
    // The code is gone from the address bar the moment it was read.
    expect(window.location.hash).toBe('');
  });

  it('never reads a token from ?sentient_editor= (E1: the query leaks to logs)', async () => {
    window.history.replaceState(null, '', '/?sentient_editor=tok');
    maybeCaptureStyles('https://api.example.com/v1');
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never runs for visitors (no code), nor on a later page of a cached session', async () => {
    maybeCaptureStyles('https://api.example.com/v1');
    await vi.advanceTimersByTimeAsync(1100);
    resetStyleCaptureForTests();
    sessionStorage.setItem('__snt_editor_token', 'cached');
    maybeCaptureStyles('https://api.example.com/v1');
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
