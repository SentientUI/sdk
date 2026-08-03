import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventQueue, type SentientEvent } from './queue';

function makeEvent(overrides: Partial<SentientEvent> = {}): SentientEvent {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    sessionId: 'sess-1',
    projectId: 'proj-1',
    componentId: 'comp-1',
    eventType: 'dwell',
    payload: {},
    timestamp: Date.now(),
    timeInSession: 100,
    ...overrides,
  };
}

const INGEST = 'https://ingest.example/events';
const KEY = 'pk_test';

describe('createEventQueue', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('events batched until flush threshold reached', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const queue = createEventQueue({
      ingestUrl: INGEST,
      apiKey: KEY,
      maxBatchSize: 3,
    });

    queue.push(makeEvent({ id: 'e1' }));
    queue.push(makeEvent({ id: 'e2' }));
    expect(fetchMock).not.toHaveBeenCalled();

    queue.push(makeEvent({ id: 'e3' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    });
    queue.destroy();
  });

  it('flush called immediately on visibilitychange to hidden', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const queue = createEventQueue({
      ingestUrl: INGEST,
      apiKey: KEY,
      maxBatchSize: 20,
    });

    queue.push(makeEvent({ id: 'vis-1' }));
    expect(fetchMock).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
      writable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    queue.destroy();
  });

  it('fetch called with correct payload and Authorization header', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const queue = createEventQueue({
      ingestUrl: INGEST,
      apiKey: KEY,
      maxBatchSize: 1,
    });

    const event = makeEvent({
      id: 'payload-1',
      variantId: 'v-a',
      goalType: 'click',
    });
    queue.push(event);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(INGEST);
    const reqInit = init as RequestInit;
    expect(reqInit.method).toBe('POST');
    expect(reqInit.keepalive).toBe(true);
    expect((reqInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);

    const batch = JSON.parse(reqInit.body as string) as SentientEvent[];
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({
      id: 'payload-1',
      sessionId: 'sess-1',
      projectId: 'proj-1',
      componentId: 'comp-1',
      variantId: 'v-a',
      eventType: 'dwell',
      goalType: 'click',
    });
    queue.destroy();
  });

  it('retry queue stored in localStorage when transport throws', () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      throw new Error('network');
    }));

    const queue = createEventQueue({
      ingestUrl: INGEST,
      apiKey: KEY,
      maxBatchSize: 1,
    });

    queue.push(makeEvent({ id: 'retry-1' }));
    queue.flush();

    const stored = localStorage.getItem(`_snt_retry_${KEY.slice(0, 12)}`);
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!) as SentientEvent[];
    expect(parsed.some((e) => e.id === 'retry-1')).toBe(true);
    queue.destroy();
  });

  it('retry queue replayed and deduplicated on init', async () => {
    const events = [
      makeEvent({ id: 'dup-1' }),
      makeEvent({ id: 'dup-2' }),
    ];
    localStorage.setItem(`_snt_retry_${KEY.slice(0, 12)}`, JSON.stringify(events));

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const queue = createEventQueue({
      ingestUrl: INGEST,
      apiKey: KEY,
      maxBatchSize: 10,
    });

    queue.push(makeEvent({ id: 'dup-1' }));
    queue.flush();

    const allBodies: SentientEvent[] = [];
    for (const [, init] of fetchMock.mock.calls) {
      const body = (init as RequestInit).body as string;
      allBodies.push(...(JSON.parse(body) as SentientEvent[]));
    }
    const dup1Count = allBodies.filter((e) => e.id === 'dup-1').length;
    expect(dup1Count).toBeLessThanOrEqual(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    queue.destroy();
  });

  it('no-op in SSR environment', () => {
    vi.stubGlobal('window', undefined);
    const queue = createEventQueue({ ingestUrl: INGEST, apiKey: KEY });
    expect(() => queue.push(makeEvent())).not.toThrow();
    expect(() => queue.flush()).not.toThrow();
    expect(() => queue.destroy()).not.toThrow();
  });

  it('two queues with different apiKeys write to separate localStorage keys', () => {
    // Synchronous throw so writeRetryQueue runs immediately (not in a .then())
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => { throw new Error('network'); }));

    const queue1 = createEventQueue({ ingestUrl: INGEST, apiKey: 'pk_project_aaa001', maxBatchSize: 1 });
    const queue2 = createEventQueue({ ingestUrl: INGEST, apiKey: 'pk_project_bbb001', maxBatchSize: 1 });

    queue1.push(makeEvent({ id: 'e-aaa' }));
    queue2.push(makeEvent({ id: 'e-bbb' }));
    queue1.destroy();
    queue2.destroy();

    const keys = Object.keys(localStorage).filter((k) => k.startsWith('_snt_retry_'));
    expect(keys.length).toBe(2);
    expect(keys.some((k) => k.includes('pk_project_a'))).toBe(true);
    expect(keys.some((k) => k.includes('pk_project_b'))).toBe(true);
  });
});

const RETRY_KEY = `_snt_retry_${KEY.slice(0, 12)}`;

function collectSentEvents(fetchMock: ReturnType<typeof vi.fn>): SentientEvent[] {
  const out: SentientEvent[] = [];
  for (const [, init] of fetchMock.mock.calls) {
    const body = (init as RequestInit).body as string;
    out.push(...(JSON.parse(body) as SentientEvent[]));
  }
  return out;
}

describe('packBatch keepalive byte budget', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('splits a flush into multiple fetch calls once UTF-8 bytes exceed 56KB', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    // maxBatchSize high so the count cap never triggers — only the byte budget should split.
    const queue = createEventQueue({
      ingestUrl: INGEST,
      apiKey: KEY,
      maxBatchSize: 10_000,
    });

    // Each event carries a ~10KB ASCII payload. ~7 fit per 56KB batch, so 20
    // events must span multiple fetch calls.
    const big = 'x'.repeat(10 * 1024);
    for (let i = 0; i < 20; i++) {
      queue.push(makeEvent({ id: `big-${i}`, payload: { blob: big } }));
    }
    queue.flush();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);

    // Every batch body (except possibly a single oversized leading event) must
    // respect the 56KB keepalive budget.
    const encoder = new TextEncoder();
    for (const [, init] of fetchMock.mock.calls) {
      const body = (init as RequestInit).body as string;
      const bytes = encoder.encode(body).length;
      const batchLen = (JSON.parse(body) as SentientEvent[]).length;
      if (batchLen > 1) {
        expect(bytes).toBeLessThanOrEqual(56 * 1024);
      }
    }

    // No event lost across the split.
    const sent = collectSentEvents(fetchMock).map((e) => e.id).sort();
    const expected = Array.from({ length: 20 }, (_, i) => `big-${i}`).sort();
    expect(sent).toEqual(expected);
    queue.destroy();
  });

  it('counts multi-byte (emoji/CJK) payloads by UTF-8 bytes, not char length', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const queue = createEventQueue({
      ingestUrl: INGEST,
      apiKey: KEY,
      maxBatchSize: 10_000,
    });

    // '😀' is 2 UTF-16 code units but 4 UTF-8 bytes; '中' is 1 char, 3 bytes.
    // 5000 emoji = ~20KB bytes but only ~10K chars. If the queue measured by
    // .length it would pack far more than fits in 56KB of real bytes.
    const emoji = '😀'.repeat(5000); // ~20KB UTF-8
    for (let i = 0; i < 12; i++) {
      queue.push(makeEvent({ id: `emoji-${i}`, payload: { blob: emoji } }));
    }
    queue.flush();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);

    const encoder = new TextEncoder();
    for (const [, init] of fetchMock.mock.calls) {
      const body = (init as RequestInit).body as string;
      const batch = JSON.parse(body) as SentientEvent[];
      const bytes = encoder.encode(body).length;
      if (batch.length > 1) {
        expect(bytes).toBeLessThanOrEqual(56 * 1024);
        // Sanity: a char-length view would have wildly underestimated the size.
        expect(body.length).toBeLessThan(bytes);
      }
    }

    const sent = collectSentEvents(fetchMock).map((e) => e.id).sort();
    expect(sent).toEqual(Array.from({ length: 12 }, (_, i) => `emoji-${i}`).sort());
    queue.destroy();
  });

  it('always sends at least one event even if it alone exceeds the byte budget', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const queue = createEventQueue({
      ingestUrl: INGEST,
      apiKey: KEY,
      maxBatchSize: 10_000,
    });

    // A single 80KB event > 56KB budget. packBatch only breaks AFTER out.length>0,
    // so the first event is always included.
    queue.push(makeEvent({ id: 'huge', payload: { blob: 'y'.repeat(80 * 1024) } }));
    queue.flush();

    const sent = collectSentEvents(fetchMock);
    expect(sent.some((e) => e.id === 'huge')).toBe(true);
    queue.destroy();
  });
});

describe('exponential backoff', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('pauses flushes after a failure and resumes once backoffUntil expires', () => {
    vi.setSystemTime(0);
    // Synchronous throw → backoff is set immediately in the same tick.
    const fetchMock = vi.fn().mockImplementation(() => { throw new Error('network'); });
    vi.stubGlobal('fetch', fetchMock);

    const queue = createEventQueue({ ingestUrl: INGEST, apiKey: KEY, maxBatchSize: 1 });

    // First push flushes, fetch throws → consecutiveFailures=1,
    // backoffUntil = 0 + min(60000, 1000*2**1) = 2000.
    queue.push(makeEvent({ id: 'fail-1' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // While inside the backoff window, flush() returns early — no new fetch.
    queue.push(makeEvent({ id: 'fail-2' }));
    queue.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Still inside window at 1999ms.
    vi.setSystemTime(1999);
    queue.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // At 2000ms the window has expired (Date.now() < backoffUntil is false).
    vi.setSystemTime(2000);
    queue.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    queue.destroy();
  });

  it('caps backoff at 60_000ms with the exponent capped at 6', () => {
    vi.setSystemTime(0);
    const fetchMock = vi.fn().mockImplementation(() => { throw new Error('network'); });
    vi.stubGlobal('fetch', fetchMock);

    const queue = createEventQueue({ ingestUrl: INGEST, apiKey: KEY, maxBatchSize: 1 });

    let calls = 0;
    // Drive consecutiveFailures up. After each failure we jump time forward past
    // the prior window so the next flush actually attempts a fetch.
    // Expected backoffUntil after the Nth failure (from now=t):
    //   t + min(60000, 1000 * 2 ** min(N, 6))
    const expectedDelay = (n: number) => Math.min(60_000, 1000 * 2 ** Math.min(n, 6));

    let now = 0;
    const failures: number[] = [];
    for (let n = 1; n <= 8; n++) {
      queue.push(makeEvent({ id: `bk-${n}` }));
      calls++;
      expect(fetchMock).toHaveBeenCalledTimes(calls);
      const delay = expectedDelay(n);
      failures.push(delay);
      // Advance to exactly the end of this failure's window so the next push flushes.
      now += delay;
      vi.setSystemTime(now);
    }

    // n=1..6 → 2000,4000,8000,16000,32000,64000→capped 60000.
    expect(failures.slice(0, 6)).toEqual([2000, 4000, 8000, 16000, 32000, 60000]);
    // n=7,8 → exponent capped at 6 → 64000 → capped at 60000.
    expect(failures[6]).toBe(60_000);
    expect(failures[7]).toBe(60_000);
    queue.destroy();
  });

  it('resets backoff to zero after a successful send', () => {
    vi.setSystemTime(0);
    // First call throws, later calls succeed.
    let attempt = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      attempt++;
      if (attempt === 1) throw new Error('network');
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const queue = createEventQueue({ ingestUrl: INGEST, apiKey: KEY, maxBatchSize: 1 });

    queue.push(makeEvent({ id: 'r-1' })); // throws → r-1 re-enqueued, backoff to 2000
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Window expired. r-1 is retried (in-session) AND succeeds, then r-2 sends —
    // two more calls — and the success resets backoff to 0.
    vi.setSystemTime(2000);
    queue.push(makeEvent({ id: 'r-2' }));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // No backoff now — immediate next push flushes right away.
    queue.push(makeEvent({ id: 'r-3' }));
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // The initially-failed r-1 was not dropped: it rode a later successful send.
    const sent = collectSentEvents(fetchMock).map((e) => e.id);
    expect(sent).toContain('r-1');
    expect(sent).toContain('r-2');
    expect(sent).toContain('r-3');
    queue.destroy();
  });
});

describe('maxRetrySize cap on the retry queue', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Each failed flush sets an exponential backoff window, so subsequent flushes are
  // suppressed until time advances. We advance the clock past 60s (the cap) between
  // pushes so every event actually attempts transport, fails, and is appended to the
  // retry bucket — letting us observe the slice(-maxRetrySize) cap accumulate.
  const pushFailing = (
    cfg: { maxRetrySize?: number },
    ids: string[],
  ): void => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => { throw new Error('network'); }));
    const queue = createEventQueue({ ingestUrl: INGEST, apiKey: KEY, maxBatchSize: 1, ...cfg });
    let now = 0;
    for (const id of ids) {
      queue.push(makeEvent({ id }));
      now += 60_000; // jump past the maximum backoff window
      vi.setSystemTime(now);
    }
    queue.destroy();
  };

  it('retry queue persisted in localStorage never exceeds the 100-event default cap', () => {
    const ids = Array.from({ length: 150 }, (_, i) => `ev-${i}`);
    pushFailing({}, ids);

    const stored = JSON.parse(localStorage.getItem(RETRY_KEY)!) as SentientEvent[];
    // The persisted bucket is de-duped by id and then hard-capped by
    // slice(-maxRetrySize), so it never exceeds the cap and never holds a
    // duplicate id regardless of how many failures accumulate. (Which ids remain
    // is not asserted: failed batches are also retried in-session, so the
    // persisted set is a rolling subset — server-side dedupe by event.id covers
    // any overlap on the reload replay.)
    expect(stored.length).toBeLessThanOrEqual(100);
    expect(stored.length).toBeGreaterThan(0);
    expect(new Set(stored.map((e) => e.id)).size).toBe(stored.length);
    expect(stored.every((e) => /^ev-\d+$/.test(e.id))).toBe(true);
  });

  it('honours a custom maxRetrySize', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `c-${i}`);
    pushFailing({ maxRetrySize: 5 }, ids);

    const stored = JSON.parse(localStorage.getItem(RETRY_KEY)!) as SentientEvent[];
    expect(stored.length).toBeLessThanOrEqual(5);
    expect(stored.length).toBeGreaterThan(0);
    expect(new Set(stored.map((e) => e.id)).size).toBe(stored.length);
    expect(stored.every((e) => /^c-\d+$/.test(e.id))).toBe(true);
  });

  // Repeatedly 5xx-ing the SAME batch must not fill the bucket with duplicate
  // ids: without de-duping, each retry appends another copy of every event, and
  // slice(-maxRetrySize) then evicts distinct earlier failures to make room for
  // the duplicates. The bucket must hold exactly one copy per id.
  it('de-dupes the persisted bucket by id when the same batch fails repeatedly', () => {
    vi.setSystemTime(0);
    // Always 5xx (synchronous Response so handleResponse runs in the same tick).
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Response(null, { status: 500 })));
    // Batch of 3 fits under maxBatchSize; cap of 4 is deliberately not a multiple
    // of the batch size so an un-deduped merge would leave a lingering duplicate.
    const queue = createEventQueue({ ingestUrl: INGEST, apiKey: KEY, maxBatchSize: 20, maxRetrySize: 4 });

    queue.push(makeEvent({ id: 'a' }));
    queue.push(makeEvent({ id: 'b' }));
    queue.push(makeEvent({ id: 'c' }));

    let now = 0;
    for (let i = 0; i < 6; i++) {
      queue.flush(); // the same [a,b,c] batch 5xx's and is re-persisted each time
      now += 60_000; // jump past the maximum backoff window
      vi.setSystemTime(now);
    }

    const stored = JSON.parse(localStorage.getItem(RETRY_KEY)!) as SentientEvent[];
    const ids = stored.map((e) => e.id).sort();
    // One copy per id — no duplicate spam, no distinct id evicted by it.
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(new Set(ids).size).toBe(ids.length);
    queue.destroy();
  });
});

describe('push/flush dedup via queuedIds', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pushing the same id repeatedly enqueues it only once', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const queue = createEventQueue({ ingestUrl: INGEST, apiKey: KEY, maxBatchSize: 50 });
    for (let i = 0; i < 10; i++) {
      queue.push(makeEvent({ id: 'same' }));
    }
    queue.flush();

    const sent = collectSentEvents(fetchMock);
    expect(sent.filter((e) => e.id === 'same').length).toBe(1);
    queue.destroy();
  });

  it('an already-sent id is not re-sent on a later push (sentIds dedup)', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    // maxBatchSize:1 makes the first push flush+confirm synchronously (Response,
    // not a Promise) so the id lands in sentIds before the second push.
    const queue = createEventQueue({ ingestUrl: INGEST, apiKey: KEY, maxBatchSize: 1 });
    queue.push(makeEvent({ id: 'once' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    queue.push(makeEvent({ id: 'once' }));
    queue.flush();

    const sent = collectSentEvents(fetchMock);
    expect(sent.filter((e) => e.id === 'once').length).toBe(1);
    queue.destroy();
  });

  it('interleaved push and flush sends each distinct event exactly once', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const queue = createEventQueue({ ingestUrl: INGEST, apiKey: KEY, maxBatchSize: 3 });

    queue.push(makeEvent({ id: 'a' }));
    queue.flush();
    queue.push(makeEvent({ id: 'b' }));
    queue.push(makeEvent({ id: 'a' })); // dup after a was flushed — should be ignored
    queue.flush();
    queue.push(makeEvent({ id: 'c' }));
    queue.flush();

    const sent = collectSentEvents(fetchMock).map((e) => e.id);
    expect(sent.filter((id) => id === 'a').length).toBe(1);
    expect(sent.filter((id) => id === 'b').length).toBe(1);
    expect(sent.filter((id) => id === 'c').length).toBe(1);
    expect(new Set(sent)).toEqual(new Set(['a', 'b', 'c']));
    queue.destroy();
  });
});

describe('in-session retry after a retryable failure', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('purges an event from the localStorage retry bucket once it is successfully sent', () => {
    vi.setSystemTime(0);
    let attempt = 0;
    // First send → 500 (persists to the retry bucket); retry → 202 (accepted).
    const fetchMock = vi.fn().mockImplementation(() => {
      attempt++;
      return new Response(null, { status: attempt === 1 ? 500 : 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const queue = createEventQueue({ ingestUrl: INGEST, apiKey: KEY, maxBatchSize: 1 });

    queue.push(makeEvent({ id: 'r-clear' }));
    // The failed batch is written to the cross-reload retry backstop.
    expect(localStorage.getItem(RETRY_KEY)).toContain('r-clear');

    // Backoff window expires → interval flush retries → 202.
    vi.setSystemTime(2000);
    queue.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Once acknowledged, the event must NOT linger in localStorage — otherwise the
    // next page load would replay an already-delivered event.
    const stored = localStorage.getItem(RETRY_KEY);
    expect(stored === null || !stored.includes('r-clear')).toBe(true);
    queue.destroy();
  });

  it('re-enqueues a 5xx-failed batch and retries it within the same queue instance', () => {
    vi.setSystemTime(0);
    let attempt = 0;
    // First send → 500 (retryable); second send → 202 (accepted). Responses are
    // returned synchronously (not Promises) so handleResponse runs in the same tick.
    const fetchMock = vi.fn().mockImplementation(() => {
      attempt++;
      return new Response(null, { status: attempt === 1 ? 500 : 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const queue = createEventQueue({ ingestUrl: INGEST, apiKey: KEY, maxBatchSize: 1 });

    // A conversion event. push → flush → 500 → re-enqueued in memory + backoff=2000.
    queue.push(makeEvent({ id: 'conv-1', eventType: 'goal_achieved', goalType: 'signup' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Still inside the backoff window: no retry yet, event is NOT lost.
    queue.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Window expired → the interval-driven flush retries the same event, now 202.
    vi.setSystemTime(2000);
    queue.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The conversion rode both attempts (server dedupes by id); it was not dropped
    // on the failure and did not require a page reload to be retried.
    const sent = collectSentEvents(fetchMock);
    expect(sent.filter((e) => e.id === 'conv-1').length).toBe(2);

    // After the success it is marked sent — a later flush does not send it again.
    queue.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    queue.destroy();
  });
});
