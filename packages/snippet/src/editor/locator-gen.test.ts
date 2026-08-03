import { describe, it, expect, beforeEach } from 'vitest';
import { generateLocator, resolvesUniquely } from './locator-gen';

beforeEach(() => { document.body.innerHTML = ''; });

describe('generateLocator', () => {
  it('prefers an element id and resolves back uniquely', () => {
    document.body.innerHTML = '<a id="hero-cta">Book a demo</a>';
    const el = document.getElementById('hero-cta')!;
    const loc = generateLocator(el, document);
    expect(loc.id).toBe('hero-cta');
    expect(loc.fingerprint).toEqual({ tag: 'a', text: 'Book a demo' });
    expect(resolvesUniquely(loc, el, document)).toBe(true);
  });

  it('captures a platform data attribute (Framer)', () => {
    document.body.innerHTML = '<a data-framer-name="Hero CTA">Go</a>';
    const el = document.querySelector('a')!;
    const loc = generateLocator(el, document);
    expect(loc.dataAttr).toEqual({ name: 'data-framer-name', value: 'Hero CTA' });
    expect(resolvesUniquely(loc, el, document)).toBe(true);
  });

  it('builds an nth-of-type CSS path that uniquely resolves an id-less element', () => {
    document.body.innerHTML = '<section id="s"><a>one</a><a>two</a><a>three</a></section>';
    const el = document.querySelectorAll('#s a')[2]!;
    const loc = generateLocator(el, document);
    expect(loc.id).toBeUndefined();
    expect(loc.selector).toContain(':nth-of-type(3)');
    expect(resolvesUniquely(loc, el, document)).toBe(true);
  });

  it('resolvesUniquely is false when the locator is ambiguous', () => {
    document.body.innerHTML = '<a class="x">one</a><a class="x">two</a>';
    const el = document.querySelector('.x')!;
    // A selector that matches both should not be treated as unique.
    expect(resolvesUniquely({ selector: '.x' }, el, document)).toBe(false);
  });

  it('escapes a leading-digit ancestor id in the CSS-path fallback (no CSS.escape)', () => {
    // Ancient engines without CSS.escape must still emit a valid selector: an id
    // starting with a digit is invalid unescaped (`#2hero` throws in a real
    // browser), so the fallback must escape it to the CSSOM code-point form.
    // (Asserted on the generated selector because jsdom's matcher can't resolve
    // an escaped leading-digit id even when the selector is correct.)
    const g = globalThis as { CSS?: unknown };
    const orig = g.CSS;
    g.CSS = undefined;
    try {
      document.body.innerHTML = '<section id="2hero"><a>one</a><a>two</a></section>';
      const el = document.querySelector('section')!.querySelectorAll('a')[1]!;
      const loc = generateLocator(el, document);
      expect(loc.selector).toContain('#\\32 hero');
      expect(loc.selector).not.toContain('#2hero');
    } finally {
      g.CSS = orig;
    }
  });

  it('escapes a digit in the SECOND position after a leading `-` in the fallback (no CSS.escape)', () => {
    // Per CSS.escape, `-1x` → `-\31 x` (a digit right after a leading `-` still
    // needs the code-point form); the old polyfill only handled a digit at
    // index 0 and emitted the invalid `#-1x`.
    const g = globalThis as { CSS?: unknown };
    const orig = g.CSS;
    g.CSS = undefined;
    try {
      document.body.innerHTML = '<section id="-1x"><a>one</a><a>two</a></section>';
      const el = document.querySelector('section')!.querySelectorAll('a')[1]!;
      const loc = generateLocator(el, document);
      expect(loc.selector).toContain('#-\\31 x');
      expect(loc.selector).not.toContain('#-1x');
    } finally {
      g.CSS = orig;
    }
  });
});
