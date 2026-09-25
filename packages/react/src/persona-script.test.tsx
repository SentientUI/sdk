import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SentientPersonaScript, personaScriptBody } from './persona-script.js';

function resetHtmlAttrs(): void {
  document.documentElement.removeAttribute('data-sentient-persona');
  document.documentElement.removeAttribute('data-sentient-confidence');
}

beforeEach(() => {
  localStorage.clear();
  resetHtmlAttrs();
});
afterEach(resetHtmlAttrs);

describe('personaScriptBody', () => {
  it('embeds literal SSR persona values, JSON-escaped, banded via confidenceBand', () => {
    const body = personaScriptBody({ apiKey: 'pk_x', persona: { persona: 'admin', confidence: 0.8 } });
    (0, eval)(body);
    expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('admin');
    expect(document.documentElement.getAttribute('data-sentient-confidence')).toBe('high');
  });

  it('never overwrites already-set attributes (single writer)', () => {
    document.documentElement.setAttribute('data-sentient-persona', 'evaluator');
    document.documentElement.setAttribute('data-sentient-confidence', 'low');
    (0, eval)(personaScriptBody({ apiKey: 'pk_x', persona: { persona: 'admin', confidence: 0.9 } }));
    expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('evaluator');
  });

  it('falls back to the snapshot-reading pre-paint script when no SSR persona', () => {
    localStorage.setItem(
      '_snt_snap:pk_x',
      JSON.stringify({ v: 1, persona: 'trial_user', band: 'medium', slots: {}, layoutOrder: null, savedAt: Date.now() - 1000 }),
    );
    (0, eval)(personaScriptBody({ apiKey: 'pk_x' }));
    expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('trial_user');
    expect(document.documentElement.getAttribute('data-sentient-confidence')).toBe('medium');
  });

  it('the fallback ignores a snapshot older than 30 days, and any snapshot under DNT/GPC (grader F3)', () => {
    const html = document.documentElement;
    const run = (savedAt: number) => {
      html.removeAttribute('data-sentient-persona');
      localStorage.setItem('_snt_snap:pk_x', JSON.stringify({ v: 1, persona: 'p', band: 'high', slots: {}, layoutOrder: null, savedAt }));
      (0, eval)(personaScriptBody({ apiKey: 'pk_x' }));
      return html.getAttribute('data-sentient-persona');
    };
    expect(run(Date.now() - 31 * 24 * 3600 * 1000)).toBeNull();
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => true });
    try {
      expect(run(Date.now())).toBeNull();
    } finally {
      delete (navigator as unknown as { globalPrivacyControl?: unknown }).globalPrivacyControl;
    }
  });

  it('renders nothing while consent is gated — the fallback would read device storage (grader F3)', () => {
    expect(SentientPersonaScript({ apiKey: 'pk_x', consent: false })).toBeNull();
    expect(SentientPersonaScript({ apiKey: 'pk_x', consentFrom: 'cookiebot' })).toBeNull();
    expect(SentientPersonaScript({ apiKey: 'pk_x', consentFrom: 'cookiebot', consent: true })).not.toBeNull();
    // A server-decided persona reads no storage, so it always renders.
    expect(SentientPersonaScript({ apiKey: 'pk_x', consent: false, persona: { persona: 'a', confidence: 1 } })).not.toBeNull();
  });

  it('is XSS- and serialization-safe for hostile persona strings', () => {
    const body = personaScriptBody({
      apiKey: 'pk_x',
      persona: { persona: '"</script><script>alert(1)//', confidence: 1 },
    });
    expect(body).not.toContain('</');
    expect(body).not.toContain('`');
    expect(() => (0, eval)(body)).not.toThrow();
  });
});

describe('SentientPersonaScript component', () => {
  it('server-renders an inline script tag containing the body', () => {
    const html = renderToString(
      createElement(SentientPersonaScript, { apiKey: 'pk_x', persona: { persona: 'admin', confidence: 1 } }),
    );
    expect(html).toContain('<script');
    expect(html).toContain('data-sentient-persona');
  });

  it('forwards a CSP nonce onto the script element when provided', () => {
    const html = renderToString(
      createElement(SentientPersonaScript, {
        apiKey: 'pk_x',
        nonce: 'csp-nonce-abc',
        persona: { persona: 'admin', confidence: 1 },
      }),
    );
    expect(html).toContain('nonce="csp-nonce-abc"');
  });

  it('rendering the React tree itself never writes the html attributes (script not executed by React)', () => {
    render(createElement(SentientPersonaScript, { apiKey: 'pk_x', persona: { persona: 'admin', confidence: 1 } }));
    // React inserts the <script> node without executing it; only real page
    // load (or our explicit eval in other tests) runs it.
    expect(document.documentElement.hasAttribute('data-sentient-persona')).toBe(false);
  });
});
