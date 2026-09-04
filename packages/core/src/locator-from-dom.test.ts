import { describe, it, expect } from 'vitest';
import { locatorFromElement } from './locator-from-dom';

function dom(html: string): Document {
  return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html');
}

describe('locatorFromElement', () => {
  it('prefers a unique id', () => {
    const d = dom('<section id="pricing">Plans</section>');
    const el = d.querySelector('#pricing')!;
    expect(locatorFromElement(el, d)).toEqual({
      v: 1,
      id: 'pricing',
      fingerprint: { tag: 'section', text: 'Plans' },
    });
  });

  it('falls back to a stable data attribute', () => {
    const d = dom('<section data-testid="hero">Hi</section>');
    const el = d.querySelector('[data-testid="hero"]')!;
    expect(locatorFromElement(el, d)).toEqual({
      v: 1,
      dataAttr: { name: 'data-testid', value: 'hero' },
      fingerprint: { tag: 'section', text: 'Hi' },
    });
  });

  it('returns the bare tag when it is already unique', () => {
    // Shortest-unique-selector: `section` beats `section.reviews` when there is
    // only one section on the page. Mirrors locator-from-html.ts candidate order.
    const d = dom('<section class="reviews">Great</section><div>x</div>');
    const el = d.querySelector('.reviews')!;
    expect(locatorFromElement(el, d)?.selector).toBe('section');
  });

  it('falls back to tag.class when the bare tag is ambiguous', () => {
    const d = dom('<section class="reviews">Great</section><section class="faq">Q</section>');
    const el = d.querySelector('.reviews')!;
    expect(locatorFromElement(el, d)?.selector).toBe('section.reviews');
  });

  it('refuses an nth-of-type selector for indistinguishable siblings', () => {
    const d = dom('<div><p>same</p><p>same</p></div>');
    const el = d.querySelectorAll('p')[1]!;
    expect(locatorFromElement(el, d)).toBeNull();
  });

  it('accepts nth-of-type when siblings differ in text', () => {
    const d = dom('<div><p>one</p><p>two</p></div>');
    const el = d.querySelectorAll('p')[1]!;
    expect(locatorFromElement(el, d)?.selector).toContain(':nth-of-type(2)');
  });
});
