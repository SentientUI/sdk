import { describe, it, expect, beforeEach } from 'vitest';
import { resolveLocatorOne } from './locator';

beforeEach(() => { document.body.innerHTML = ''; });

describe('resolveLocatorOne', () => {
  it('resolves by id first', () => {
    document.body.innerHTML = '<a id="cta">Book</a>';
    expect(resolveLocatorOne({ id: 'cta' }, document)!.id).toBe('cta');
  });

  it('falls back to a platform data attribute', () => {
    document.body.innerHTML = '<a data-framer-name="Hero CTA">Book</a>';
    const el = resolveLocatorOne({ dataAttr: { name: 'data-framer-name', value: 'Hero CTA' } }, document);
    expect(el).not.toBeNull();
  });

  it('falls back to the CSS selector', () => {
    document.body.innerHTML = '<div id="hero"><a class="cta">x</a></div>';
    expect(resolveLocatorOne({ selector: '#hero .cta' }, document)).not.toBeNull();
  });

  it('returns null on multiple matches (never guesses)', () => {
    document.body.innerHTML = '<a class="cta"></a><a class="cta"></a>';
    expect(resolveLocatorOne({ selector: '.cta' }, document)).toBeNull();
  });

  it('returns null on zero matches', () => {
    expect(resolveLocatorOne({ selector: '#nope' }, document)).toBeNull();
  });

  it('verifies the fingerprint tag and loose text', () => {
    document.body.innerHTML = '<a id="cta">Book a demo</a>';
    expect(resolveLocatorOne({ id: 'cta', fingerprint: { tag: 'a', text: 'Book' } }, document)).not.toBeNull();
    expect(resolveLocatorOne({ id: 'cta', fingerprint: { tag: 'button' } }, document)).toBeNull();
  });

  it('skips a dataAttr whose name is not a safe attribute name', () => {
    // The value is escaped; the name is validated the same way rather than
    // interpolated raw. A name with selector metacharacters resolves to null
    // (the dataAttr branch is skipped) — never a thrown or unintended selector.
    document.body.innerHTML = '<a data-x="v" id="real">x</a>';
    expect(resolveLocatorOne({ dataAttr: { name: 'data-x]', value: 'v' } }, document)).toBeNull();
    expect(resolveLocatorOne({ dataAttr: { name: 'data-x][onx', value: 'v' } }, document)).toBeNull();
  });

  it('honors urlMatch scoping', () => {
    document.body.innerHTML = '<a id="cta">x</a>';
    // jsdom default path is '/', which does not include '/pricing'.
    expect(resolveLocatorOne({ id: 'cta', urlMatch: '/pricing' }, document)).toBeNull();
  });
});
