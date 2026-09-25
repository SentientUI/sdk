import { renderToString } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { renderBlocks, renderCompose } from './blocks-render.js';

describe('like: borrowing site styles', () => {
const vocabulary = { rev: 'r', images: [], entries: [
  { id: 'button-primary', role: 'button-primary', classes: 'px-8 py-3 bg-blue-600 text-white rounded-lg', computed: {}, seen: { url: '/', count: 1, at: '' }, source: 'editor' },
] } as never;

  it('a resolvable like renders the site class list and NO palette paint', () => {
  const html = renderToString(renderBlocks({ type: 'button', like: 'button-primary', label: 'Go', href: 'https://x.test/c' } as never,
    { palette: { primaryBg: '#111827', primaryText: '#ffffff', radius: '8px' }, vocabulary })!);
  expect(html).toContain('class="px-8 py-3 bg-blue-600 text-white rounded-lg"');
  expect(html).not.toContain('background');
  expect(html).not.toContain('border-radius');
  });
  it('an unresolvable like falls back to palette styling (degraded, never blank)', () => {
  const html = renderToString(renderBlocks({ type: 'button', like: 'gone', label: 'Go', href: 'https://x.test/c' } as never,
    { palette: { primaryBg: '#111827', primaryText: '#ffffff', radius: '8px' }, vocabulary })!);
  expect(html).toContain('background:#111827');
  expect(html).not.toContain('class=');
  });
  it('stacks keep their layout styles when borrowing a card class list', () => {
  const html = renderToString(renderBlocks({ type: 'stack', direction: 'row', gap: 'md', like: 'button-primary', children: [{ type: 'text', value: 'a' }] } as never, { palette: null, vocabulary })!);
  expect(html).toContain('display:flex');
  expect(html).toContain('gap:16px');
});

  it('renderCompose paints the tree on the site surface class', () => {
    const v = { rev: 'r', images: [], entries: [{ id: 'section-dark', role: 'section', classes: 'bg-slate-900 py-24', computed: {}, seen: { url: '/', count: 1, at: '' }, source: 'editor' }] } as never;
    const html = renderToString(renderCompose({ surface: { like: 'section-dark' }, tree: { type: 'text', value: 'hi' } } as never, { palette: null, vocabulary: v })!);
    expect(html).toContain('<div class="bg-slate-900 py-24">');
  });
});

// A style whose class list doesn't set a text colour carries the colour it
// was sampled with (the Bodyshop "WhatsApp a few photos" button rendered
// black-on-slate inside the contact card, 2026-09-24).
describe('inherited text colour', () => {
  const at = '2026-09-24T00:00:00.000Z';
  const vocabulary = {
    rev: 'r', images: [],
    entries: [
      { id: 'glass', role: 'button-secondary', classes: 'px-6 py-4 bg-white/10 border rounded-lg', computed: { color: 'rgb(255, 255, 255)', inheritsColor: true }, seen: { url: '/', count: 1, at }, source: 'editor' },
      { id: 'blue', role: 'button-primary', classes: 'bg-blue-600 text-white', computed: { color: 'rgb(255, 255, 255)' }, seen: { url: '/', count: 1, at }, source: 'editor' },
    ],
  } as never;
  it('paints the sampled colour on an element whose classes do not set it', () => {
    const html = renderToString(renderBlocks({ type: 'button', label: 'WhatsApp', href: '/x', like: 'glass' } as never, { palette: null, vocabulary })!);
    expect(html).toMatch(/class="px-6 py-4 bg-white\/10 border rounded-lg"/);
    expect(html).toMatch(/style="color:rgb\(255, 255, 255\)"/);
  });
  it('leaves a class list that sets its own colour alone (its hover states keep working)', () => {
    const html = renderToString(renderBlocks({ type: 'button', label: 'Quote', href: '/x', like: 'blue' } as never, { palette: null, vocabulary })!);
    expect(html).not.toMatch(/color:rgb/);
  });
});
