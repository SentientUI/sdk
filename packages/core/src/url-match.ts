/**
 * url_reached matching, shared by the snippet (client-side wiring) and the API
 * (server-side matching on pageview ingest) so the two can never disagree about
 * whether a path satisfies a goal.
 *
 * A pattern matches the current path on an exact hit or a path-segment
 * boundary — never a bare substring. Substring matching made the degenerate '/'
 * pattern (what the editor's "Track page visits" button saves on a homepage)
 * contain every path, firing the homepage goal on every route; it also let
 * '/pricing' over-match '/pricing-details'. The root '/' matches only '/', and
 * '/pricing' matches '/pricing' and '/pricing/monthly' but not '/pricing-x'.
 */
export function urlMatches(pattern: string, path: string): boolean {
  if (!pattern) return false;
  if (pattern === '/') return path === '/';
  const p = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  return path === p || path.startsWith(`${p}/`);
}

/**
 * Reduce a pasted full URL to its path. An operator who copies
 * `https://host/pricing` into a url_reached goal saved a pattern that no
 * pathname ever starts with, so the goal silently never fired. A path (or
 * anything unparseable) passes through unchanged.
 */
export function normalizeUrlPattern(p: string): string {
  if (!/^https?:\/\//i.test(p)) return p;
  try {
    return new URL(p).pathname || '/';
  } catch {
    return p;
  }
}
