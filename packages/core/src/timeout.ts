// Browser request ceilings (audit S8). No browser fetch had a timeout, so a
// stalled connection — captive portal, dropped mobile radio, an overloaded
// edge — held a decide or an assign open indefinitely while the page sat on
// its baseline, and a hung ingest POST wedged a queue's in-flight slot.

/** Read-only calls (winner, weights) and each session upsert. */
export const REQUEST_TIMEOUT_MS = 5000;
/** A SENT decide or assign. The server records them whether or not we read
 *  the answer (decide's slot_decisions rows are trials; assign logs the
 *  exposure at draw time) — so neither is ever cut short on latency (a slow answer is still applied late, which is
 *  what makes the trial real). This ceiling only frees a dead connection. */
export const DECIDE_TIMEOUT_MS = 30000;
/** Durable queue POSTs. Retried on abort, and deduplicated server-side by
 *  event id / goal id, so a timeout never double-counts. */
export const QUEUE_TIMEOUT_MS = 15000;
/** How long decide/assign wait for the session upsert before giving up
 *  WITHOUT sending: the session retry chain can run ~14 s under 429s, and a
 *  decision that is never requested writes no trial (a late decide would —
 *  close-out books every slot_decisions row, CONTRACTS §2 "Which decisions
 *  exist"). The page keeps its baseline; the next page view decides. */
export const SESSION_WAIT_MS = 2500;

/** An AbortSignal that fires after `ms`, and a `clear` for when the request
 *  settles. No-op where AbortController is missing (the signal is optional). */
export function timeoutSignal(ms: number): { signal?: AbortSignal; clear: () => void } {
  if (typeof AbortController !== 'function') return { clear: () => undefined };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, clear: () => clearTimeout(t) };
}

/** Resolves true when `p` settles within `ms`, false otherwise. */
export function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    const done = (): void => {
      clearTimeout(t);
      resolve(true);
    };
    p.then(done, done);
  });
}
