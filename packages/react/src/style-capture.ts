// Style-vocabulary capture for React installs (native generation phase 2).
// React sites never load the snippet editor, so without this a React project
// (Bodyshop) would only ever get the crawler's colorless guess. Runs ONLY when
// this page load exchanged a fresh editor code (#sentient_editor_code=, see
// editor-session.ts), i.e. when an operator opened the page from the dashboard
// — never for visitors, and not on every later page of a cached session. The
// sampler is a separate core subpath, dynamically imported, so the normal
// bundle pays nothing.
import { editorSession, resetEditorSessionForTests } from './editor-session.js';

let started = false;

export function maybeCaptureStyles(apiBaseUrl?: string): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const base = (apiBaseUrl ?? 'https://api.sentient-ui.com/v1').replace(/\/$/, '');
  void editorSession(base).then((session) => {
    if (!session || !('token' in session) || !session.fresh) return;
    capture(base, session.token);
  });
}

function capture(base: string, token: string): void {
  // After load + 1s, so client-rendered heroes exist before we look.
  const run = (): void => {
    window.setTimeout(() => {
      void import('@sentientui/core/style-sample')
        .then(({ sampleStyleVocabulary }) =>
          fetch(`${base}/editor/style-vocabulary`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(sampleStyleVocabulary(document)),
          }),
        )
        .catch(() => undefined);
    }, 1000);
  };
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
}

/** Test hook. */
export function resetStyleCaptureForTests(): void {
  started = false;
  resetEditorSessionForTests();
}
