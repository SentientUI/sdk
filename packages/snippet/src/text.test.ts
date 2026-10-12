import { describe, it, expect } from 'vitest';
import { applyContentText, canTestText, currentText, soleTextNode } from './text';

const html = (markup: string): Element => {
  document.body.innerHTML = markup;
  return document.body.firstElementChild!;
};

describe('text versions on real markup', () => {
  it('treats a label + icon as one place for copy', () => {
    const a = html('<a>Let’s Collaborate <svg><path d="M0 0"/></svg></a>');
    expect(soleTextNode(a)?.nodeValue?.trim()).toBe('Let’s Collaborate');
    expect(canTestText(a)).toBe(true);
  });

  it('refuses several text nodes — no single place the copy belongs', () => {
    const h = html('<h1>Get <span>started</span></h1>');
    expect(soleTextNode(h)).toBeNull();
    expect(canTestText(h)).toBe(false);
  });

  it('allows a leaf, including an empty one', () => {
    expect(canTestText(html('<button>Go</button>'))).toBe(true);
    expect(canTestText(html('<button></button>'))).toBe(true);
  });

  it('ignores script/style text when looking for the label', () => {
    const b = html('<button>Buy<style>.x{}</style></button>');
    expect(canTestText(b)).toBe(true);
  });

  it('swaps only the label and keeps the icon', () => {
    const a = html('<a>Let’s Collaborate<svg id="i"></svg></a>');
    applyContentText(a, 'Talk to our enterprise team');
    expect(a.textContent).toBe('Talk to our enterprise team');
    expect(a.querySelector('#i')).not.toBeNull();
  });

  it('snapshots the label itself, so a restore puts back exactly what was there', () => {
    const a = html('<a>\n  Contact\n  <svg></svg></a>');
    const before = currentText(a);
    applyContentText(a, 'Book a call');
    applyContentText(a, before);
    expect(a.innerHTML).toBe('\n  Contact\n  <svg></svg>');
  });
});
