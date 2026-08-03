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
