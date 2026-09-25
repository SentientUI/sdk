import { afterEach, describe, expect, it } from 'vitest';
import { applyNonce, cspNonce, setCspNonce } from './csp-nonce.js';
import { reveal, resetRevealStyles } from './reveal.js';

afterEach(() => {
  setCspNonce(undefined);
  resetRevealStyles();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('CSP nonce (audit S20)', () => {
  it('prefers the explicit nonce, else borrows a page script\'s', () => {
    expect(cspNonce()).toBeUndefined();
    const s = document.createElement('script');
    s.setAttribute('nonce', 'page-n');
    document.head.appendChild(s);
    expect(cspNonce()).toBe('page-n');
    setCspNonce('explicit-n');
    expect(cspNonce()).toBe('explicit-n');
    expect(applyNonce(document.createElement('style')).getAttribute('nonce')).toBe('explicit-n');
  });

  it('the reveal stylesheet carries it', () => {
    setCspNonce('rv');
    const el = document.createElement('p');
    el.textContent = 'new';
    document.body.appendChild(el);
    reveal(el, { previous: 'old' });
    expect(document.getElementById('sentient-reveal')?.getAttribute('nonce')).toBe('rv');
  });
});
