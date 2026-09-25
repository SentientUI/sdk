import { sessionCookieName, storageSuffix, LEGACY_SESSION_COOKIE_NAME, markForgotten } from './storage-key.js';
import { SNAPSHOT_STORAGE_KEY_PREFIX } from './snapshot.js';
import { retryStorageKey } from './queue.js';
import { goalRetryStorageKey } from './goal-queue.js';

/**
 * Forget-me WITHOUT a client: delete everything the SDK stores for `apiKey`'s
 * visitor. `client.destroy()` does this for a live tracking client, which only
 * exists when consent was granted in this page view — so a visitor who said
 * "no" somewhere the SDK wasn't watching (a CMP settings page, checkout)
 * kept the 365-day id, the decision snapshot and the retry buckets for good,
 * and the pre-paint script kept personalizing from that snapshot (audit N2).
 * Callers run this when the consent source reports a refusal at boot.
 *
 * Writes nothing unless something was stored: the legacy tombstone (which
 * stops this project re-adopting the shared bare `_snt_uid`) is only written
 * when there is a bare id to block. Returns whether anything was removed.
 */
export function forgetVisitor(apiKey: string): boolean {
  if (typeof window === 'undefined' || !apiKey) return false;
  markForgotten(apiKey);
  let removed = false;
  const name = sessionCookieName(apiKey);
  try {
    if (new RegExp(`(?:^|; )${name}=`).test(document.cookie)) {
      const secure = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${name}=; max-age=0; SameSite=lax; path=/${secure}`;
      removed = true;
    }
  } catch {
    /* cookies unavailable */
  }
  const suffix = storageSuffix(apiKey);
  const exact = [
    name,
    // Written by builds before 2026; current SDKs only ever delete it.
    '_snt_graph_edges',
    SNAPSHOT_STORAGE_KEY_PREFIX + apiKey,
    retryStorageKey(apiKey),
    goalRetryStorageKey(apiKey),
    `_snt_graph_nodes${suffix}`,
  ];
  const prefixes = [`_snt_asgn${suffix}_`];
  for (const store of ['localStorage', 'sessionStorage'] as const) {
    try {
      const s = window[store];
      for (const k of exact) {
        if (s.getItem(k) !== null) {
          s.removeItem(k);
          removed = true;
        }
      }
      for (let i = s.length - 1; i >= 0; i--) {
        const k = s.key(i);
        if (k && prefixes.some((p) => k.startsWith(p))) {
          s.removeItem(k);
          removed = true;
        }
      }
    } catch {
      /* storage unavailable */
    }
  }
  try {
    // Every layer session.ts's legacy read adopts from, sessionStorage too.
    const bare =
      new RegExp(`(?:^|; )${LEGACY_SESSION_COOKIE_NAME}=[^;]`).test(document.cookie) ||
      localStorage.getItem(LEGACY_SESSION_COOKIE_NAME) !== null ||
      sessionStorage.getItem(LEGACY_SESSION_COOKIE_NAME) !== null;
    if (bare) localStorage.setItem(`${LEGACY_SESSION_COOKIE_NAME}_tomb${suffix}`, '1');
  } catch {
    /* storage unavailable */
  }
  return removed;
}
