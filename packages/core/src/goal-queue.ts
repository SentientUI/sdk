/**
 * Durable transport for `POST /v1/goals`.
 *
 * A conversion is the single most valuable event the SDK emits, and it used to
 * be the least reliable one: `goal()` fired a bare `fetch(...).catch(() => {})`,
 * which only observes network-layer failures. A 429 (the per-IP limit is 100
 * req/min, and shared egress — corporate NAT, carriers, storefront proxies —
 * hits it routinely), a 5xx, or a 400 all RESOLVE, so the catch never ran and
 * the response was discarded unread. The conversion was gone with no retry and
 * nothing surfaced to the developer.
 *
 * This gives goals the same guarantees the event queue has always had: retry
 * with backoff in-session, a localStorage bucket that survives reload, and
 * dedupe by id. Retry is safe because `goalId` is a client-generated UUID that
 * the server dedupes on (`ON CONFLICT DO NOTHING`) — the safety was already
 * there, it just wasn't used.
 *
 * Unlike events, `/v1/goals` takes ONE goal per request, so this is a serial
 * sender rather than a batcher, and a flush sends at most `maxPerFlush` so a
 * backlog drains at a pace the rate limiter tolerates instead of re-triggering
 * the 429 that created it.
 */

import { backoffDelayMs, classifyResponse, drainBucket, purgeBucket, writeBucket } from './durable.js';

/** One queued conversion. `id` is the goalId — the server's dedupe key. */
export type PendingGoal = {
  id: string;
  /** Pre-serialized request body, so a persisted goal replays byte-identically. */
  body: string;
};

export type GoalQueueConfig = {
  /** Absolute URL of the goals endpoint. */
  url: string;
  apiKey: string;
  headers: Record<string, string>;
  flushIntervalMs?: number;
  maxRetrySize?: number;
  maxPerFlush?: number;
  /** Called when a goal is permanently dropped (non-retryable status), so the
   *  client can warn in debug mode. Never called for retryable failures. */
  onDrop?: (goal: PendingGoal, status: number) => void;
};

export type GoalQueue = {
  /** Sends immediately; on a retryable failure the goal is queued and retried. */
  send(goal: PendingGoal): void;
  flush(): void;
  destroy(): void;
};

const MAX_SENT_IDS = 200;

/**
 * Persisted goal-retry bucket key, namespaced by apiKey prefix so multiple
 * projects on one origin keep separate buckets. Exported so the client's
 * forget-me teardown can remove it.
 */
export function goalRetryStorageKey(apiKey: string): string {
  return `_snt_goal_retry_${apiKey.slice(0, 12)}`;
}

const SSR_GOAL_QUEUE: GoalQueue = {
  send: () => undefined,
  flush: () => undefined,
  destroy: () => undefined,
};

export function createGoalQueue(config: GoalQueueConfig): GoalQueue {
  if (typeof window === 'undefined') return SSR_GOAL_QUEUE;

  const flushIntervalMs = config.flushIntervalMs ?? 5000;
  const maxRetrySize = config.maxRetrySize ?? 100;
  const maxPerFlush = config.maxPerFlush ?? 5;
  const RETRY_KEY = goalRetryStorageKey(config.apiKey);

  const pending: PendingGoal[] = [];
  const pendingIds = new Set<string>();
  const sentIds = new Set<string>();
  const sentIdOrder: string[] = [];

  let backoffUntil = 0;
  let consecutiveFailures = 0;
  let disposed = false;

  const markSent = (goal: PendingGoal): void => {
    pendingIds.delete(goal.id);
    if (!sentIds.has(goal.id)) {
      sentIds.add(goal.id);
      sentIdOrder.push(goal.id);
    }
    while (sentIdOrder.length > MAX_SENT_IDS) {
      const oldest = sentIdOrder.shift();
      if (oldest) sentIds.delete(oldest);
    }
    // Acknowledged (delivered, or dropped as unretryable) — clear it from the
    // cross-reload bucket so the next page load doesn't replay it.
    purgeBucket([goal.id], RETRY_KEY);
  };

  const markFailed = (goal: PendingGoal): void => {
    writeBucket([goal], maxRetrySize, RETRY_KEY);
    if (!sentIds.has(goal.id) && !pendingIds.has(goal.id)) {
      pendingIds.add(goal.id);
      pending.push(goal);
    }
    // One failed ROUND counts once, however many goals were in flight. flush()
    // launches up to maxPerFlush transports synchronously, so counting per goal
    // turned a single bad tick into consecutiveFailures=5 and a 32s backoff
    // where the first failure warrants 2s. queue.ts counts per batch; match it.
    if (Date.now() >= backoffUntil) {
      consecutiveFailures++;
      backoffUntil = Date.now() + backoffDelayMs(consecutiveFailures);
    }
  };

  const transport = (goal: PendingGoal): void => {
    let res: Promise<Response> | Response;
    try {
      res = fetch(config.url, {
        method: 'POST',
        keepalive: true,
        body: goal.body,
        headers: config.headers,
      });
    } catch {
      // Synchronous throw (jsdom in tests, or extreme browser failure).
      markFailed(goal);
      return;
    }

    const handle = (r: Response): void => {
      const outcome = classifyResponse(r);
      if (outcome === 'retry') {
        markFailed(goal);
        return;
      }
      // Terminal either way, but a drop is a wiring bug the developer can fix —
      // a 400 "session not found", a 401 from a misconfigured origin allowlist —
      // and used to be swallowed entirely. Say so instead of failing silently.
      if (outcome === 'dropped') config.onDrop?.(goal, r.status);
      markSent(goal);
      consecutiveFailures = 0;
      backoffUntil = 0;
    };

    // fetch can return a plain value under test stubs. Handle both.
    if (res instanceof Promise) res.then(handle).catch(() => markFailed(goal));
    else handle(res);
  };

  const flush = (): void => {
    try {
      if (disposed) return;
      if (Date.now() < backoffUntil) return;
      let sentThisTick = 0;
      while (pending.length > 0 && sentThisTick < maxPerFlush) {
        if (Date.now() < backoffUntil) break; // a same-tick failure re-armed backoff
        const goal = pending.shift()!;
        pendingIds.delete(goal.id);
        if (sentIds.has(goal.id)) continue;
        sentThisTick++;
        transport(goal);
      }
    } catch {
      /* never throw from a lifecycle handler */
    }
  };

  // Replay anything a previous page load failed to deliver. Left for the first
  // interval tick rather than sent now, so a page that reloads under an ongoing
  // outage doesn't stampede the endpoint during init.
  const restored = drainBucket<PendingGoal>(RETRY_KEY, maxRetrySize);
  for (const goal of restored) {
    if (!pendingIds.has(goal.id)) {
      pendingIds.add(goal.id);
      pending.push(goal);
    }
  }
  // drainBucket CLEARS storage as it reads, but only maxPerFlush goals leave per
  // tick — so a 40-goal backlog moved to memory and the visitor navigating two
  // seconds later lost the 35 that hadn't been sent yet. Put them straight back;
  // markSent purges each id individually once it is actually acknowledged.
  if (restored.length > 0) writeBucket(restored, maxRetrySize, RETRY_KEY);

  const intervalId = setInterval(flush, flushIntervalMs);
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') flush();
  };
  const onPageHide = (): void => flush();
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);

  return {
    send(goal: PendingGoal): void {
      if (disposed) return;
      if (sentIds.has(goal.id) || pendingIds.has(goal.id)) return;
      // A conversion goes out now — it is often the last thing that happens
      // before a redirect to a thank-you page. Only a failure makes it queued.
      if (Date.now() < backoffUntil) {
        // Persist BEFORE parking it in memory. A goal only ever reached the
        // cross-reload bucket via markFailed — i.e. only after a failed attempt
        // — so a conversion queued during someone else's backoff lived in memory
        // alone, and flush() early-returns while backoff is armed, so pagehide
        // could not rescue it either. A purchase firing 300ms after a rate-limited
        // add_to_cart was lost on the checkout redirect: exactly the outage this
        // queue exists to survive.
        writeBucket([goal], maxRetrySize, RETRY_KEY);
        pendingIds.add(goal.id);
        pending.push(goal);
        return;
      }
      transport(goal);
    },
    flush,
    destroy(): void {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      flush();
      disposed = true;
    },
  };
}
