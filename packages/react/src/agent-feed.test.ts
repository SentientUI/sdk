import { describe, it, expect, beforeEach } from 'vitest';
import {
  defineAgentContent,
  getAgentContent,
  clearAgentContent,
  buildAgentFeed,
  renderAgentJsonLd,
  renderAgentMarkdown,
} from './agent-feed.js';

beforeEach(() => clearAgentContent());

describe('defineAgentContent registry', () => {
  it('stores and retrieves developer-supplied content by page', () => {
    defineAgentContent('/pricing', { title: 'Pricing — Acme', summary: 'Three plans' });
    expect(getAgentContent('/pricing')).toEqual({ title: 'Pricing — Acme', summary: 'Three plans' });
  });

  it('returns undefined for an unknown page', () => {
    expect(getAgentContent('/nope')).toBeUndefined();
  });
});

describe('buildAgentFeed', () => {
  it('merges SDK-known blocks/layout with developer-supplied content', () => {
    const feed = buildAgentFeed({
      page: '/pricing',
      layoutOrder: ['hero', 'plans'],
      blocks: [{ id: 'hero', variant: 'B', content: { headline: 'Save more' } }],
      content: { title: 'Pricing', products: [{ name: 'Pro' }] },
    });
    expect(feed.page).toBe('/pricing');
    expect(feed.title).toBe('Pricing');
    expect(feed.products).toEqual([{ name: 'Pro' }]);
    expect(feed.layoutOrder).toEqual(['hero', 'plans']);
    expect(feed.blocks).toEqual([{ id: 'hero', variant: 'B', content: { headline: 'Save more' } }]);
  });

  it('falls back to the registry when content is not passed explicitly', () => {
    defineAgentContent('/pricing', { title: 'From registry' });
    const feed = buildAgentFeed({ page: '/pricing', blocks: [] });
    expect(feed.title).toBe('From registry');
  });

  it('never lets developer content overwrite SDK-authoritative fields (page, blocks)', () => {
    const feed = buildAgentFeed({
      page: '/x',
      blocks: [{ id: 'a', variant: '1' }],
      content: { page: '/evil', blocks: 'nope' } as Record<string, unknown>,
    });
    expect(feed.page).toBe('/x');
    expect(feed.blocks).toEqual([{ id: 'a', variant: '1' }]);
  });
});

describe('renderAgentJsonLd', () => {
  it('wraps the feed in a JSON-LD script tag', () => {
    const html = renderAgentJsonLd(buildAgentFeed({ page: '/p', blocks: [] }));
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('</script>');
  });

  it('escapes < to prevent breaking out of the script element', () => {
    const html = renderAgentJsonLd(
      buildAgentFeed({ page: '/p', blocks: [], content: { title: '</script><script>alert(1)' } }),
    );
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c');
  });
});

describe('renderAgentMarkdown', () => {
  it('renders title, summary and blocks as markdown', () => {
    const md = renderAgentMarkdown(
      buildAgentFeed({
        page: '/pricing',
        blocks: [{ id: 'hero', variant: 'B', content: { headline: 'Save more' } }],
        content: { title: 'Pricing', summary: 'Three plans' },
      }),
    );
    expect(md).toContain('# Pricing');
    expect(md).toContain('Three plans');
    expect(md).toContain('hero');
  });
});
