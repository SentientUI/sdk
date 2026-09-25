import { describe, it, expect } from 'vitest';
import { LIKE_ID_RE, STYLE_ROLES, MAX_STYLE_ENTRIES, MAX_SITE_IMAGES } from './style-vocabulary.js';

describe('style vocabulary constants', () => {
  it('like ids are short slugs — never class lists, never selectors', () => {
    expect(LIKE_ID_RE.test('button-primary')).toBe(true);
    expect(LIKE_ID_RE.test('r-9c1e02ab-3')).toBe(true);
    expect(LIKE_ID_RE.test('px-8 py-3')).toBe(false);
    expect(LIKE_ID_RE.test('.btn')).toBe(false);
    expect(LIKE_ID_RE.test('node:0')).toBe(false); // resolved server-side before persist
    expect(LIKE_ID_RE.test('role:heading-1')).toBe(false); // ditto
  });
  it('pins the role list the server classifier and the prompt share', () => {
    expect(STYLE_ROLES).toEqual([
      'button-primary', 'button-secondary', 'button-ghost', 'link',
      'heading-1', 'heading-2', 'heading-3', 'eyebrow',
      'text-lead', 'text-body', 'text-muted', 'text-small',
      'badge', 'card', 'section', 'image', 'list',
    ]);
    expect(MAX_STYLE_ENTRIES).toBe(60);
    expect(MAX_SITE_IMAGES).toBe(40);
  });
});
