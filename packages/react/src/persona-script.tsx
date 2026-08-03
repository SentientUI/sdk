import { renderPrePaintScript } from '@sentientui/core';
import { confidenceBand } from '@sentientui/policy';

export type SentientPersonaScriptProps = {
  /** Publishable API key — selects the localStorage snapshot in the fallback path. */
  apiKey: string;
  /**
   * CSP nonce for the inline pre-paint script. Pass the same nonce your
   * `Content-Security-Policy` `script-src` allows (e.g. from Next.js middleware).
   * Required for strict CSP deployments that block `'unsafe-inline'`.
   */
  nonce?: string;
  /**
   * SSR-decided persona (from `loadAdaptiveDecision`). When present the
   * script embeds the literal values; when absent it reads the local
   * decision snapshot (SPA / return-visit path).
   */
  persona?: { persona: string; confidence: number } | null;
};

/** JSON string literal that is also safe inside an inline <script> element. */
function inlineJsString(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** Exported for tests. Builds the inline JS (concatenation only — no backticks). */
export function personaScriptBody(props: SentientPersonaScriptProps): string {
  if (props.persona) {
    return (
      '(function(){try{var d=document.documentElement;' +
      'if(d.hasAttribute("data-sentient-persona"))return;' +
      'd.setAttribute("data-sentient-persona",' + inlineJsString(props.persona.persona) + ');' +
      'd.setAttribute("data-sentient-confidence",' + inlineJsString(confidenceBand(props.persona.confidence)) + ');' +
      '}catch(e){}})();'
    );
  }
  return renderPrePaintScript(props.apiKey);
}

/**
 * Single writer of the Rung-1a `<html>` attributes
 * (`data-sentient-persona`, `data-sentient-confidence`), executed pre-paint.
 *
 * `AdaptiveRoot` renders this automatically as its first child. For Pages
 * Router / Remix, render it yourself in `_document` / the root layout.
 *
 * IMPORTANT (install docs): add `suppressHydrationWarning` to your `<html>`
 * element — this script mutates documentElement before React hydrates it
 * (the same pattern next-themes uses). The client SDK adopts the attributes
 * as truth and never rewrites them mid-session.
 */
export function SentientPersonaScript(props: SentientPersonaScriptProps): JSX.Element {
  return (
    <script
      data-sentient-persona-script=""
      nonce={props.nonce}
      dangerouslySetInnerHTML={{ __html: personaScriptBody(props) }}
    />
  );
}
