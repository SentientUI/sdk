import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoalQueue, goalRetryStorageKey, type PendingGoal } from './goal-queue';

const URL_ = 'https://api.example/v1/goals';
const KEY = 'pk_test_abcdefghijkl';
const HEADERS = { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` };

function goal(id: string, name = 'purchase'): PendingGoal {
  return { id, body: JSON.stringify({ goalId: id, sessionId: 'sess-1', name }) };
}

function make(overrides: Partial<Parameters<typeof createGoalQueue>[0]> = {}) {
  return createGoalQueue({ url: URL_, apiKey: KEY, headers: HEADERS, ...overrides });
}

/** Lets the fetch promise's .then handler run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createGoalQueue', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sends a conversion immediately rather than waiting for a flush tick', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const q = make();
    q.send(goal('g1'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe(URL_);
    expect(opts.method).toBe('POST');
    expect(opts.keepalive).toBe(true);
    expect(opts.headers).toEqual(HEADERS);
    expect(JSON.parse(opts.body).goalId).toBe('g1');
    q.destroy();
  });

  // The regression this whole module exists for: these used to be dropped
  // silently because `fetch().catch()` never sees a resolved error response.
  it.each([500, 502, 429])('retries a %i on the next flush, replaying the same goalId', async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const q = make({ flushIntervalMs: 1000 });
    q.send(goal('g1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // First failure arms a 2s backoff, so the 1s tick is a no-op and the 3s one sends.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).goalId).toBe('g1');
    q.destroy();
  });

  it('drops a 400 without retrying and reports it, so a wiring bug is visible', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const onDrop = vi.fn();

    const q = make({ flushIntervalMs: 1000, onDrop });
    q.send(goal('g1'));
    await vi.advanceTimersByTimeAsync(0);

    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1' }), 400);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never retried
    expect(localStorage.getItem(goalRetryStorageKey(KEY))).toBeNull();
    q.destroy();
  });

  it('does not report a delivered 2xx as a drop', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const onDrop = vi.fn();

    const q = make({ onDrop });
    q.send(goal('g1'));
    await settle();

    expect(onDrop).not.toHaveBeenCalled();
    q.destroy();
  });

  it('persists a failed conversion and replays it on the next page load', async () => {
    const failing = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', failing);

    const first = make();
    first.send(goal('g1'));
    await settle();
    first.destroy();

    const persisted = JSON.parse(localStorage.getItem(goalRetryStorageKey(KEY))!) as PendingGoal[];
    expect(persisted.map((g) => g.id)).toEqual(['g1']);

    // New page load, endpoint healthy again.
    vi.useFakeTimers();
    const healthy = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', healthy);

    const second = make({ flushIntervalMs: 1000 });
    expect(healthy).not.toHaveBeenCalled(); // not sent during init
    await vi.advanceTimersByTimeAsync(1000);

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(healthy.mock.calls[0]![1].body).goalId).toBe('g1');
    // Acknowledged → the bucket must not replay it a third time.
    expect(localStorage.getItem(goalRetryStorageKey(KEY))).toBeNull();
    second.destroy();
  });

  it('never sends the same goalId twice', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const q = make();
    q.send(goal('g1'));
    await settle();
    q.send(goal('g1'));
    q.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    q.destroy();
  });

  it('paces a backlog so draining it cannot re-trigger the rate limit that caused it', async () => {
    vi.useFakeTimers();
    // Seed a 12-goal backlog from a previous load.
    localStorage.setItem(
      goalRetryStorageKey(KEY),
      JSON.stringify(Array.from({ length: 12 }, (_, i) => goal(`g${i}`))),
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const q = make({ flushIntervalMs: 1000, maxPerFlush: 5 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(12);
    q.destroy();
  });

  it('persists a conversion queued while backoff is armed', async () => {
    vi.useFakeTimers();
    // g1 fails and arms a 2s backoff. g2 — the valuable one — is sent inside
    // that window, so it never reaches transport and never fails, which used to
    // mean it never reached the durable bucket either. The tab then goes away.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const q = make({ flushIntervalMs: 60_000 });
    q.send(goal('g1'));
    await vi.advanceTimersByTimeAsync(0);
    q.send(goal('g2'));

    const stored = JSON.parse(localStorage.getItem(goalRetryStorageKey(KEY)) ?? '[]') as Array<{ id: string }>;
    expect(stored.map((g) => g.id)).toContain('g2');
    q.destroy();
  });

  it('keeps an undrained backlog in storage until each goal is acknowledged', async () => {
    vi.useFakeTimers();
    // drainBucket clears storage as it reads. With maxPerFlush=5, a 12-goal
    // backlog used to sit entirely in memory after init, so an unload before the
    // third tick lost whatever had not gone out yet.
    localStorage.setItem(
      goalRetryStorageKey(KEY),
      JSON.stringify(Array.from({ length: 12 }, (_, i) => goal(`g${i}`))),
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const q = make({ flushIntervalMs: 1000, maxPerFlush: 5 });
    // Before any tick: the whole backlog is still durable.
    expect(JSON.parse(localStorage.getItem(goalRetryStorageKey(KEY)) ?? '[]')).toHaveLength(12);

    await vi.advanceTimersByTimeAsync(1000);
    // Five acknowledged, seven still to go — and still persisted.
    const left = JSON.parse(localStorage.getItem(goalRetryStorageKey(KEY)) ?? '[]') as Array<{ id: string }>;
    expect(left).toHaveLength(7);
    expect(left.map((g) => g.id)).toEqual(['g5', 'g6', 'g7', 'g8', 'g9', 'g10', 'g11']);
    q.destroy();
  });

  it('counts one failed flush round once, not once per goal in flight', async () => {
    vi.useFakeTimers();
    // Five goals go out in one tick and all fail. Counting per goal produced
    // consecutiveFailures=5 → a 32s backoff; one failed round warrants 2s.
    localStorage.setItem(
      goalRetryStorageKey(KEY),
      JSON.stringify(Array.from({ length: 5 }, (_, i) => goal(`g${i}`))),
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const q = make({ flushIntervalMs: 1000, maxPerFlush: 5 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    // 2s later the queue must be sending again. Under the per-goal count it
    // would still be waiting on a 32s backoff.
    await vi.advanceTimersByTimeAsync(2500);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(5);
    q.destroy();
  });

  it('flushes pending conversions on pagehide', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const q = make({ flushIntervalMs: 60_000 });
    q.send(goal('g1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past the 2s backoff the first failure armed, then leave the page.
    await vi.advanceTimersByTimeAsync(2500);
    window.dispatchEvent(new Event('pagehide'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    q.destroy();
  });

  it('survives a synchronous fetch throw by queueing for retry', async () => {
    vi.useFakeTimers();
    let throwOnce = true;
    const fetchMock = vi.fn(() => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('network down');
      }
      return Promise.resolve(new Response(null, { status: 202 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const q = make({ flushIntervalMs: 1000 });
    expect(() => q.send(goal('g1'))).not.toThrow();
    await vi.advanceTimersByTimeAsync(3000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    q.destroy();
  });

  it('is inert after destroy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const q = make();
    q.destroy();
    q.send(goal('g1'));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
