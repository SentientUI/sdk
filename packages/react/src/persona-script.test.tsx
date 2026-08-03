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
    const body = personaScriptBody({ apiKey: 'pk_x', persona: { persona: 'buyer', confidence: 0.8 } });
    (0, eval)(body);
    expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('buyer');
    expect(document.documentElement.getAttribute('data-sentient-confidence')).toBe('high');
  });

  it('never overwrites already-set attributes (single writer)', () => {
    document.documentElement.setAttribute('data-sentient-persona', 'researcher');
    document.documentElement.setAttribute('data-sentient-confidence', 'low');
    (0, eval)(personaScriptBody({ apiKey: 'pk_x', persona: { persona: 'buyer', confidence: 0.9 } }));
    expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('researcher');
  });

  it('falls back to the snapshot-reading pre-paint script when no SSR persona', () => {
    localStorage.setItem(
      '_snt_snap:pk_x',
      JSON.stringify({ v: 1, persona: 'deal_seeker', band: 'medium', slots: {}, layoutOrder: null, savedAt: 1 }),
    );
    (0, eval)(personaScriptBody({ apiKey: 'pk_x' }));
    expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('deal_seeker');
    expect(document.documentElement.getAttribute('data-sentient-confidence')).toBe('medium');
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
      createElement(SentientPersonaScript, { apiKey: 'pk_x', persona: { persona: 'buyer', confidence: 1 } }),
    );
    expect(html).toContain('<script');
    expect(html).toContain('data-sentient-persona');
  });

  it('forwards a CSP nonce onto the script element when provided', () => {
    const html = renderToString(
      createElement(SentientPersonaScript, {
        apiKey: 'pk_x',
        nonce: 'csp-nonce-abc',
        persona: { persona: 'buyer', confidence: 1 },
      }),
    );
    expect(html).toContain('nonce="csp-nonce-abc"');
  });

  it('rendering the React tree itself never writes the html attributes (script not executed by React)', () => {
    render(createElement(SentientPersonaScript, { apiKey: 'pk_x', persona: { persona: 'buyer', confidence: 1 } }));
    // React inserts the <script> node without executing it; only real page
    // load (or our explicit eval in other tests) runs it.
    expect(document.documentElement.hasAttribute('data-sentient-persona')).toBe(false);
  });
});
