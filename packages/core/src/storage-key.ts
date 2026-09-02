/**
 * Per-project browser-storage namespace suffix, derived from the public apiKey.
 *
 * Multiple SentientUI projects (different `pk_` keys) can run on the same exact
 * origin. Storage keyed only by name (`_snt_uid`, `_snt_asgn_*`,
 * `_snt_graph_nodes`) would then collide across projects — the visitor id in
 * particular, whose session row is keyed globally server-side, would let one
 * project's traffic land on another's session. Suffixing every browser key with
 * the apiKey prefix isolates projects, matching the queue's existing
 * `_snt_retry_${apiKey.slice(0,12)}` convention.
 *
 * Returns `''` when no apiKey is available (local mode) so keys stay stable
 * there.
 */
export function storageSuffix(apiKey?: string): string {
  return apiKey ? `_${apiKey.slice(0, 12)}` : '';
}

/**
 * The bare, pre-namespacing session cookie name. Still read as a FALLBACK
 * everywhere the suffixed name is read, so visitors who got their identity
 * before per-project namespacing keep it instead of being minted a fresh one.
 */
export const LEGACY_SESSION_COOKIE_NAME = '_snt_uid';

/**
 * The one place the session cookie's name is decided. The writer (session.ts)
 * and every reader (core/server.ts SSR helper, graph sync, react devtools) must
 * call THIS — when namespacing landed, the writer moved to the suffixed name
 * while three readers kept the bare `_snt_uid`, so every SSR request for a
 * returning visitor missed the cookie and minted a fresh orphan session (quota
 * inflation, broken sticky assignments and persona continuity), and graph sync
 * sent `sessionId: undefined`. Deriving both sides from one function makes that
 * drift impossible, and index.test.ts pins the reader against the writer.
 */
export function sessionCookieName(apiKey?: string): string {
  return `${LEGACY_SESSION_COOKIE_NAME}${storageSuffix(apiKey)}`;
}
