// The operator's editor session on a React site (dashboard "Preview on your
// site", "Refresh from page", style capture). The dashboard sends a one-time
// code in the URL FRAGMENT (#sentient_editor_code=, grade E1) — never the
// token itself, which as `?sentient_editor=` reached server/CDN logs,
// analytics page URLs and Referer headers, and can publish. This trades the
// code for the token (POST /v1/editor/exchange; the API checks the Origin is
// the project's own) and keeps the token in sessionStorage only.
//
// Memoised: cell preview, region refresh and style capture all ask, but the
// code is single use — a second exchange would be refused and whichever
// caller lost the race would report an "expired" link that was fine.
import { takeHashParam } from './hash-param.js';

// Same key as the snippet's cache, so both SDKs agree on "this tab is in an
// editor session" if a page ever carries both.
const TOKEN_KEY = '__snt_editor_token';

export type EditorSession = { token: string; fresh: boolean };
type Outcome = EditorSession | { error: number } | null;

let pending: Promise<Outcome> | null = null;
let active = false;

/** Synchronous: did editorSession() find a code or a cached token? Lets a
 *  caller refuse to act on a bare URL param (a visitor, not an operator)
 *  without waiting for the exchange — the old token-in-query check was sync. */
export function editorSessionActive(): boolean {
  return active;
}

function cached(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * The editor token for this page view: exchanged from a fresh fragment code
 * (`fresh: true`), else the one cached earlier in this tab. `{ error }` is a
 * refused exchange (401 = expired/used, anything else = couldn't load); null
 * means this is not an editor session at all.
 */
export function editorSession(apiBase: string): Promise<Outcome> {
  if (pending) return pending;
  const code = typeof window === 'undefined' ? null : takeHashParam('sentient_editor_code');
  if (!code) {
    const t = typeof window === 'undefined' ? null : cached();
    active = !!t;
    pending = Promise.resolve(t ? { token: t, fresh: false } : null);
    return pending;
  }
  active = true;
  pending = fetch(`${apiBase}/editor/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
    .then(async (res): Promise<Outcome> => {
      const token = res.ok ? ((await res.json()) as { token?: string }).token : undefined;
      if (!token) return { error: res.ok ? 500 : res.status };
      try {
        sessionStorage.setItem(TOKEN_KEY, token);
      } catch {
        /* the session still works for this page view */
      }
      return { token, fresh: true };
    })
    .catch((): Outcome => ({ error: 0 }));
  return pending;
}

/** End the session (Exit preview): a reload is a normal visit again. */
export function endEditorSession(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* fail-safe */
  }
}

/** Test hook. */
export function resetEditorSessionForTests(): void {
  pending = null;
  active = false;
}
