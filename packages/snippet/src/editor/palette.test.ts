import { describe, it, expect, beforeEach } from 'vitest';
import { deriveSitePalette } from './palette';

function button(styles: string): string {
  return `<button style="${styles}">Go</button>`;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
});

describe('deriveSitePalette', () => {
  it('picks the dominant button look (background, text color, radius)', () => {
    document.body.innerHTML =
      button('background-color: rgb(20, 40, 200); color: rgb(255, 255, 255); border-radius: 6px') +
      button('background-color: rgb(20, 40, 200); color: rgb(255, 255, 255); border-radius: 6px') +
      button('background-color: rgb(200, 0, 0); color: rgb(255, 255, 255); border-radius: 2px');
    expect(deriveSitePalette(document)).toEqual({
      primaryBg: 'rgb(20, 40, 200)',
      primaryText: 'rgb(255, 255, 255)',
      radius: '6px',
    });
  });

  it('ignores transparent and page-background buttons; null when nothing qualifies', () => {
    document.body.innerHTML =
      button('background-color: transparent') + button('background-color: rgba(0, 0, 0, 0)');
    expect(deriveSitePalette(document)).toBeNull();
  });

  it('falls back to 8px when the radius is not a plain px value', () => {
    document.body.innerHTML =
      button('background-color: rgb(20, 40, 200); color: rgb(255, 255, 255); border-radius: 50%');
    expect(deriveSitePalette(document)?.radius).toBe('8px');
  });

  it('samples link-buttons and submit inputs, not plain links', () => {
    document.body.innerHTML =
      '<a class="Btn-primary" style="background-color: rgb(1, 2, 3); color: rgb(255, 255, 255)">Buy</a>' +
      '<a style="background-color: rgb(9, 9, 9); color: rgb(255, 255, 255)">A plain link with a background</a>';
    expect(deriveSitePalette(document)?.primaryBg).toBe('rgb(1, 2, 3)');
  });

  it('never throws on a weird document', () => {
    expect(deriveSitePalette({} as never)).toBeNull();
  });
});
