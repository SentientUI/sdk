/** Batched event queue with reliable transport (fetch + keepalive, localStorage retry). */

import { backoffDelayMs, classifyResponse, drainBucket, purgeBucket, writeBucket } from './durable.js';

export type EventType =
  | 'variant_assigned'
  | 'goal_achieved'
  | 'scroll_depth'
  | 'dwell'
  | 'cursor_signal'
  | 'component_visible'
  | 'component_exited'
  | 'micro_signal'
  // A funnel DECLARATION, not telemetry: the server upserts the funnel entity
  // and never stores it in raw_events. Listed here so callers can express it
  // without casting through the track() signature.
  | 'funnel_declared'
  // One per page load and per SPA route change, so a visit's journey through the
  // site is reconstructable. Carries `path` and nothing else.
  | 'pageview';

export type SentientEvent = {
  id: string;
  sessionId: string;
  projectId: string;
  componentId: string;
  variantId?: string;
  eventType: EventType;
  goalType?: string;
  /**
   * Page path the event happened on, e.g. `/pricing`. Set automatically from
   * `location.pathname` — deliberately NOT `location.href`, so query strings
   * (which routinely carry emails, reset tokens and order ids) never leave the
   * browser. The server re-strips them anyway; this is the first of two gates.
   * Undefined outside a browser (SSR), where there is no page to name.
   */
  path?: string;
  payload: Record<string, unknown>;
  timestamp: number;
  timeInSession: number;
};

export type QueueConfig = {
  ingestUrl: string;
  apiKey: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxRetrySize?: number;
};

export type EventQueue = {
  push(event: SentientEvent): void;
  flush(): void;
  destroy(): void;
};

const MAX_SENT_IDS = 500;
// 64 KB is the per-origin keepalive budget on every modern browser. We split unload
// flushes into chunks below this to avoid the whole batch being dropped.
const KEEPALIVE_BUDGET_BYTES = 56 * 1024;

/**
 * Persisted retry-bucket key, namespaced by apiKey prefix so multiple projects
 * on the same origin each get their own bucket. Exported so the client's
 * forget-me teardown can remove it.
 */
export function retryStorageKey(apiKey: string): string {
  return `_snt_retry_${apiKey.slice(0, 12)}`;
}

const SSR_QUEUE: EventQueue = {
  push: () => undefined,
  flush: () => undefined,
  destroy: () => undefined,
};

/**
 * Creates a batched event queue with periodic and lifecycle-triggered flushes.
 */
export function createEventQueue(config: QueueConfig): EventQueue {
  if (typeof window === 'undefined') {
    return SSR_QUEUE;
  }

  const flushIntervalMs = config.flushIntervalMs ?? 5000;
  const maxBatchSize = config.maxBatchSize ?? 20;
  const maxRetrySize = config.maxRetrySize ?? 100;
  const ingestUrl = config.ingestUrl;
  const apiKey = config.apiKey;
  const RETRY_KEY = retryStorageKey(apiKey);

  const queue: SentientEvent[] = [];
  const sentIds = new Set<string>();
  const sentIdOrder: string[] = [];

  const markSent = (ids: string[]): void => {
    for (const id of ids) {
      queuedIds.delete(id); // free the in-flight slot
      if (sentIds.has(id)) continue;
      sentIds.add(id);
      sentIdOrder.push(id);
    }
    while (sentIdOrder.length > MAX_SENT_IDS) {
      const oldest = sentIdOrder.shift();
      if (oldest) sentIds.delete(oldest);
    }
    // A batch that previously 5xx'd was persisted to the cross-reload retry
    // backstop. Now that it's acknowledged (delivered, or 4xx-dropped as
    // unretryable), drop those ids from localStorage too — otherwise the next
    // page load would replay an already-handled event. `sentIds` is in-memory
    // only, so it can't suppress that cross-reload duplicate on its own.
    purgeBucket(ids, RETRY_KEY);
  };

  // Tracks IDs currently in `queue` or in flight (handed to transportBatch
  // but not yet confirmed). Entries are removed on markSent or when an event
  // is dropped, so the set stays bounded by in-flight + queued size.
  const queuedIds = new Set<string>();

  // Bound the in-memory queue at the same cap as the persisted retry bucket
  // (maxRetrySize). During a sustained outage flush() keeps re-enqueueing every
  // failed batch while the page keeps producing events, and only the
  // localStorage bucket was capped — so a multi-hour outage on a long-lived
  // SPA tab grew this array without limit. Drop-oldest, matching writeBucket's
  // slice(-max) shed policy: the newest events are the ones a recovering
  // server can still use.
  const capQueue = (): void => {
    while (queue.length > maxRetrySize) {
      const dropped = queue.shift();
      if (dropped) queuedIds.delete(dropped.id);
    }
  };

  const enqueue = (event: SentientEvent): void => {
    if (sentIds.has(event.id) || queuedIds.has(event.id)) return;
    queuedIds.add(event.id);
    queue.push(event);
    capQueue();
  };

  // A retryable failure hands the batch back to the in-memory queue so the
  // backoff-gated interval flush retries it in-session (localStorage is only the
  // cross-reload backstop). The ids are still tracked in queuedIds — they were
  // pulled from `queue` on flush but never markSent — so we re-add them WITHOUT
  // going through enqueue (which would skip them as already-queued) and without
  // deleting/re-adding queuedIds. Already-sent events are never re-queued, and a
  // single event stays a single copy: `queue` is fully drained each flush.
  const requeueFailed = (batch: SentientEvent[]): void => {
    for (const event of batch) {
      if (sentIds.has(event.id)) continue;
      queuedIds.add(event.id); // idempotent — keeps id-tracking consistent
      queue.push(event);
    }
    // Failed batches count against the same bound as fresh pushes — this path
    // is exactly the one that grew unbounded during an outage (see capQueue).
    capQueue();
  };

  const retryEvents = drainBucket<SentientEvent>(RETRY_KEY, maxRetrySize);
  for (const event of retryEvents) {
    enqueue(event);
  }

  // Pause flushing until backoff expires.
  let backoffUntil = 0;
  let consecutiveFailures = 0;

  // Authenticated transport. keepalive: true gives unload-survival; we still await
  // the response so 5xx/429 actually surface and we can retry.
  const transportBatch = (batch: SentientEvent[], salvage = true): void => {
    if (batch.length === 0) return;
    const body = JSON.stringify(batch);
    const ids = batch.map((e) => e.id);

    let pending: Promise<Response> | Response;
    try {
      pending = fetch(ingestUrl, {
        method: 'POST',
        keepalive: true,
        body,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      });
    } catch {
      // Synchronous throw (typically jsdom in tests, or extreme browser failure).
      writeBucket(batch, maxRetrySize, RETRY_KEY);
      requeueFailed(batch);
      consecutiveFailures++;
      backoffUntil = Date.now() + backoffDelayMs(consecutiveFailures);
      return;
    }

    // fetch can sometimes return a value directly (tests using stubGlobal). Handle both.
    const handleResponse = (res: Response): void => {
      if (classifyResponse(res) !== 'retry') {
        // An API older than migration 108 400s the whole batch over the unknown
        // 'pageview' type, and a 4xx is terminal — which silently dropped the
        // co-batched exposures and goals too. Re-send once without the
        // pageviews (valid on the old API); the pageviews themselves are
        // unsendable there and are dropped as delivered.
        if (!res.ok && salvage) {
          const rest = batch.filter((e) => e.eventType !== 'pageview');
          if (rest.length > 0 && rest.length < batch.length) {
            markSent(batch.filter((e) => e.eventType === 'pageview').map((e) => e.id));
            transportBatch(rest, false);
            return;
          }
        }
        // 2xx = success. 4xx (except 429) will never succeed — drop them rather than loop.
        markSent(ids);
        consecutiveFailures = 0;
        backoffUntil = 0;
        return;
      }
      // 5xx / 429 → retry with backoff.
      writeBucket(batch, maxRetrySize, RETRY_KEY);
      requeueFailed(batch);
      consecutiveFailures++;
      backoffUntil = Date.now() + backoffDelayMs(consecutiveFailures);
    };

    if (pending instanceof Promise) {
      pending.then(handleResponse).catch(() => {
        writeBucket(batch, maxRetrySize, RETRY_KEY);
        requeueFailed(batch);
        consecutiveFailures++;
        backoffUntil = Date.now() + backoffDelayMs(consecutiveFailures);
      });
    } else {
      handleResponse(pending);
    }
  };

  // Pack events into a batch that stays under the keepalive byte budget AND the
  // configured event-count cap. Returns the prefix of `pool` that fits.
  // Uses UTF-8 byte length (not char count) — emoji/CJK payloads can be 3–4×
  // larger as bytes and would otherwise blow the keepalive budget.
  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const byteLength = (s: string): number =>
    encoder ? encoder.encode(s).length : s.length;
  const packBatch = (pool: SentientEvent[]): SentientEvent[] => {
    const out: SentientEvent[] = [];
    let bytes = 2; // for the surrounding []
    for (const e of pool) {
      const size = byteLength(JSON.stringify(e)) + 1; // +1 for comma
      if (out.length > 0 && bytes + size > KEEPALIVE_BUDGET_BYTES) break;
      if (out.length >= maxBatchSize) break;
      out.push(e);
      bytes += size;
    }
    return out;
  };

  const flush = (): void => {
    try {
      if (Date.now() < backoffUntil) return;
      while (queue.length > 0) {
        // Re-check inside the loop: transportBatch can set backoffUntil
        // synchronously (a sync throw or a same-tick Response) and re-enqueue the
        // failed batch, so a mid-drain backoff must stop further chunks this tick
        // (otherwise the just-re-enqueued batch would immediately retry-loop).
        if (Date.now() < backoffUntil) break;
        const pending = queue.filter((e) => !sentIds.has(e.id));
        queue.length = 0;
        if (pending.length === 0) break;
        const batch = packBatch(pending);
        if (batch.length === 0) break;
        // Put anything we didn't pack back on the queue for the next tick.
        if (batch.length < pending.length) {
          queue.push(...pending.slice(batch.length));
        }
        transportBatch(batch);
      }
    } catch {
      /* never throw */
    }
  };

  let flushTimerActive = true;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  intervalId = setInterval(() => {
    if (!flushTimerActive) return;
    flush();
  }, flushIntervalMs);

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      flush();
    }
  };

  // `pagehide` (not `beforeunload`): a `beforeunload` listener can disqualify a
  // page from the back/forward cache. `pagehide` fires on real unloads AND on
  // bfcache eviction, and `visibilitychange:hidden` already covers most leaves,
  // so flush-on-leave stays covered without inhibiting bfcache.
  const onPageHide = (): void => {
    flush();
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);

  return {
    push(event: SentientEvent): void {
      enqueue(event);
      if (queue.length >= maxBatchSize) {
        flush();
      }
    },
    flush,
    destroy(): void {
      flushTimerActive = false;
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      flush();
    },
  };
}
