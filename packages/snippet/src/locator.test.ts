import { describe, it, expect, beforeEach } from 'vitest';
import { isLocatorMiss, locatorCandidateExists, resolveLocatorOne } from './locator';

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

describe('locatorCandidateExists', () => {
  it('is true when elements are found but resolution rejects them', () => {
    document.body.innerHTML = '<a id="cta">Book</a><a class="x"></a><a class="x"></a>';
    expect(locatorCandidateExists({ id: 'cta', fingerprint: { tag: 'button' } }, document)).toBe(true);
    expect(locatorCandidateExists({ selector: '.x' }, document)).toBe(true);
    expect(locatorCandidateExists({ id: 'nope', selector: '#nope' }, document)).toBe(false);
  });
});

describe('isLocatorMiss', () => {
  it('counts absence only where the component is page-scoped to be', () => {
    // jsdom path is '/'.
    expect(isLocatorMiss({ id: 'faq', page: '/' }, document)).toBe(true);
    expect(isLocatorMiss({ id: 'faq', page: '*' }, document)).toBe(true);
    expect(isLocatorMiss({ id: 'faq', page: '/pricing' }, document)).toBe(false);
    expect(isLocatorMiss({ id: 'faq' }, document)).toBe(false);
  });

  it('unscoped: counts a rejected candidate on any page; URL-scoped out stays silent', () => {
    document.body.innerHTML = '<a id="cta">Book</a>';
    expect(isLocatorMiss({ id: 'cta', fingerprint: { tag: 'button' } }, document)).toBe(true);
    expect(isLocatorMiss({ id: 'cta', fingerprint: { tag: 'button' }, urlMatch: '/pricing' }, document)).toBe(false);
  });

  it('page-scoped to another path: silent even when a look-alike candidate is rejected here', () => {
    // A /pricing component with a generic selector (h1, .hero, a shared id)
    // used to collect a "candidate rejected" miss from every OTHER page that
    // had such an element — an element on / says nothing about /pricing, and
    // that is exactly the false suspension page scope exists to prevent.
    document.body.innerHTML = '<a id="cta">Book</a>';
    expect(isLocatorMiss({ id: 'cta', fingerprint: { tag: 'button' }, page: '/pricing' }, document)).toBe(false);
    expect(isLocatorMiss({ id: 'cta', selector: 'a', fingerprint: { tag: 'button' }, page: '/products/*' }, document)).toBe(false);
    // On its own page a rejected candidate is still a miss.
    expect(isLocatorMiss({ id: 'cta', fingerprint: { tag: 'button' }, page: '/' }, document)).toBe(true);
    expect(isLocatorMiss({ id: 'cta', fingerprint: { tag: 'button' }, page: '*' }, document)).toBe(true);
  });
});
