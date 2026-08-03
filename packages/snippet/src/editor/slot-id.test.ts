// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { deriveSlotId } from './index';
import { generateLocator } from './locator-gen';

function elFor(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

describe('deriveSlotId', () => {
  it('is readable, kind-prefixed, and within 1..128 chars', () => {
    const e = elFor('<h1 id="hero-cta">Buy now</h1>');
    const id = deriveSlotId('text', generateLocator(e, document), e);
    expect(id).toMatch(/^text-/);
    expect(id.length).toBeGreaterThanOrEqual(1);
    expect(id.length).toBeLessThanOrEqual(128);
    expect(id).toMatch(/hero-cta/);
  });

  it('is stable for the same element + kind', () => {
    const e = elFor('<h1 id="hero-cta">Buy now</h1>');
    const a = deriveSlotId('text', generateLocator(e, document), e);
    const b = deriveSlotId('text', generateLocator(e, document), e);
    expect(a).toBe(b);
  });

  it('differs across kinds on the same element', () => {
    const e = elFor('<h1 id="hero-cta">Buy now</h1>');
    const loc = generateLocator(e, document);
    expect(deriveSlotId('text', loc, e)).not.toBe(deriveSlotId('move', loc, e));
  });

  it('differs across distinct elements (no collision → no overwrite)', () => {
    document.body.innerHTML = '<section id="about">About</section><section id="contact">Contact</section>';
    const about = document.getElementById('about')!;
    const contact = document.getElementById('contact')!;
    const idA = deriveSlotId('move', generateLocator(about, document), about);
    const idC = deriveSlotId('move', generateLocator(contact, document), contact);
    expect(idA).not.toBe(idC);
  });

  it('falls back to a hash when there is no readable handle', () => {
    document.body.innerHTML = '<div><span></span></div>';
    const span = document.querySelector('span')!;
    const id = deriveSlotId('style', generateLocator(span, document), span);
    expect(id).toMatch(/^style-/);
    expect(id.length).toBeLessThanOrEqual(128);
  });
});
