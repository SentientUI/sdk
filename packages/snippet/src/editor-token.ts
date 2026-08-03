// Shared key for stashing the on-site editor bearer token in sessionStorage.
// The snippet strips the token from the URL immediately (security: keep it out of
// history, referrer, bookmarks, and logs) but caches it here so a plain reload —
// or navigating to another page of the same site within this tab — re-enters
// editor mode without reopening the dashboard. Kept in its own tiny module so both
// IIFE bundles (snippet + editor) can share the constant without either importing
// the other's entry point. Cleared by the editor when the token is unauthorized
// (401) or when the user closes the editor.
const EDITOR_TOKEN_KEY = '__snt_editor_token';

export function readCachedEditorToken(): string | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(EDITOR_TOKEN_KEY) : null;
  } catch {
    return null; // storage disabled/partitioned → behave as if uncached
  }
}

export function cacheEditorToken(token: string): void {
  try {
    sessionStorage.setItem(EDITOR_TOKEN_KEY, token);
  } catch {
    /* fail-safe — caching is a convenience, not a requirement */
  }
}

export function clearCachedEditorToken(): void {
  try {
    sessionStorage.removeItem(EDITOR_TOKEN_KEY);
  } catch {
    /* fail-safe */
  }
}
