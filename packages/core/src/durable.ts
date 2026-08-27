/**
 * Reliability primitives shared by every outbound SDK transport.
 *
 * Extracted from queue.ts so the goal sender cannot drift from the event
 * queue on the three decisions that decide whether data survives: which
 * responses are worth retrying, how long to wait, and how the cross-reload
 * bucket is read and written. Behaviour is byte-identical to the versions
 * these replace.
 */

const MAX_BACKOFF_MS = 60_000;
/** 2^6 s = 64 s, already past MAX_BACKOFF_MS — the cap that stops the shift overflowing. */
const BACKOFF_EXPONENT_CAP = 6;

/** Delay before the next attempt after `consecutiveFailures` failed ones (1-based). */
export function backoffDelayMs(consecutiveFailures: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(consecutiveFailures, BACKOFF_EXPONENT_CAP));
}

/** What one delivery attempt achieved. `dropped` is terminal but unsuccessful. */
export type DeliveryOutcome = 'delivered' | 'dropped' | 'retry';

/**
 * Classifies a response into the three outcomes that matter to a transport.
 *
 * 2xx delivered. A 4xx other than 429 will never succeed however many times we
 * try it (bad key, rejected body, unknown session), so retrying it loops
 * forever and starves real data out of the bucket — drop it, but distinctly,
 * so callers can tell the developer. 429 and 5xx are transient.
 *
 * `ok` is consulted before `status` deliberately: it is the semantic check, and
 * it keeps stubs that set only `ok` (used throughout the SDK test suite)
 * behaving as they did before this was extracted. An unrecognizable response
 * with neither is treated as retryable, matching the original queue.
 */
export function classifyResponse(res: { ok?: boolean; status?: number }): DeliveryOutcome {
  if (res.ok === true) return 'delivered';
  const { status } = res;
  if (typeof status !== 'number') return 'retry';
  if (status >= 200 && status < 300) return 'delivered';
  if (status >= 400 && status < 500 && status !== 429) return 'dropped';
  return 'retry';
}

/** Anything a persisted bucket can hold: it needs a stable server-side dedupe id. */
export type Identified = { id: string };

/**
 * Reads a persisted bucket AND clears it — the caller takes ownership of the
 * items and is responsible for re-persisting any that fail again. Returns the
 * newest `max` entries; a corrupt or absent bucket reads as empty.
 */
export function drainBucket<T extends Identified>(storageKey: string, max: number): T[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as T[];
    if (!Array.isArray(parsed)) return [];
    localStorage.removeItem(storageKey);
    return parsed.slice(-max);
  } catch {
    return [];
  }
}

/**
 * Merges `items` into the persisted bucket, de-duped by id (last write wins)
 * before the size cap. The dedupe matters: a batch that 5xx's repeatedly
 * in-session hands the same ids back on every retry, and without it each retry
 * appends another copy and `slice(-max)` evicts other distinct failed items to
 * make room for the duplicates.
 */
export function writeBucket<T extends Identified>(items: T[], max: number, storageKey: string): void {
  try {
    const existing = (() => {
      try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return [] as T[];
        const parsed = JSON.parse(raw) as T[];
        return Array.isArray(parsed) ? parsed : ([] as T[]);
      } catch {
        return [] as T[];
      }
    })();
    const byId = new Map<string, T>();
    for (const e of existing) byId.set(e.id, e);
    for (const e of items) byId.set(e.id, e);
    localStorage.setItem(storageKey, JSON.stringify([...byId.values()].slice(-max)));
  } catch {
    /* storage unavailable — the in-memory retry path still applies */
  }
}

/**
 * Removes the given ids from the persisted bucket. Called once an item is
 * acknowledged so a transient failure that was written to localStorage isn't
 * replayed on the next page load after the in-session retry succeeded.
 */
export function purgeBucket(ids: string[], storageKey: string): void {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Identified[];
    if (!Array.isArray(parsed)) return;
    const drop = new Set(ids);
    const remaining = parsed.filter((e) => !drop.has(e.id));
    if (remaining.length === parsed.length) return; // nothing to remove
    if (remaining.length === 0) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify(remaining));
  } catch {
    /* ignore */
  }
}
