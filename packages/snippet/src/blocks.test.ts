import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BlockNode } from '@sentientui/core';
import { renderBlock, applySlotBlocks, setBlockPalette, restoreBlockContainer, sweepOrphanBlocks, BLOCK_ARM_ATTR } from './blocks';
import { applyRegistrySlots } from './apply';

const CTA_ROW: BlockNode = {
  type: 'stack',
  direction: 'row',
  gap: 'md',
  children: [
    { type: 'button', label: 'Buy now', href: 'https://shop.example/buy', emphasis: 'primary', tag: 'cta_primary' },
    { type: 'button', label: 'Learn more', href: 'https://shop.example/learn', emphasis: 'secondary' },
  ],
};
const CTA_COL: BlockNode = {
  type: 'stack',
  direction: 'column',
  children: [{ type: 'button', label: 'Try free', href: 'https://shop.example/try' }],
};

function wrapperFor(container: Element, arm: string): HTMLElement | null {
  return Array.from(container.children).find((c) => c.getAttribute(BLOCK_ARM_ATTR) === arm) as HTMLElement | null ?? null;
}

beforeEach(() => {
  document.body.innerHTML = '<section id="hero"><h1>Original</h1><p class="sub">Sub</p></section>';
});

describe('renderBlock', () => {
  it('renders the spec §4 CTA row via createElement — no HTML path exists', () => {
    const el = renderBlock(CTA_ROW, document)!;
    expect(el.tagName).toBe('DIV');
    expect(el.style.display).toBe('flex');
    expect(el.style.gap).toBe('16px');
    const [buy, learn] = Array.from(el.children) as HTMLAnchorElement[];
    expect(buy!.tagName).toBe('A');
    expect(buy!.textContent).toBe('Buy now');
    expect(buy!.href).toBe('https://shop.example/buy');
    expect(buy!.getAttribute('data-sentient-tag')).toBe('cta_primary');
    expect(learn!.style.border.toLowerCase()).toContain('currentcolor'); // secondary emphasis
  });

  it('writes markup-looking text as text, never as elements', () => {
    const el = renderBlock({ type: 'text', value: '<img src=x onerror=alert(1)>' }, document)!;
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(el.children.length).toBe(0);
  });

  it('renders heading level and grid columns from tokens', () => {
    const h = renderBlock({ type: 'heading', value: 'Hi', level: 3, size: 'lg' }, document)!;
    expect(h.tagName).toBe('H3');
    const g = renderBlock(
      { type: 'grid', columns: 3, children: [{ type: 'spacer', size: 'sm' }] },
      document,
    )!;
    // Responsive auto-fit with the 1/columns share cap (never MORE than 3
    // columns; fewer when the 200px floor kicks in on narrow screens).
    expect(g.style.gridTemplateColumns).toContain('auto-fit');
    expect(g.style.gridTemplateColumns).toContain('/ 3');
  });

  describe('site palette (derived, not chosen)', () => {
    afterEach(() => setBlockPalette(null));

    it('primary buttons render in the served palette; neutrals are only the fallback', () => {
      const btn: BlockNode = { type: 'button', label: 'Buy', href: 'https://x.example/b' };
      const neutral = renderBlock(btn, document)!;
      expect(neutral.style.background).toBe('rgb(17, 24, 39)'); // jsdom normalizes #111827
      expect(neutral.style.borderRadius).toBe('8px');

      setBlockPalette({ primaryBg: 'rgb(20, 40, 200)', primaryText: 'rgb(255, 255, 0)', radius: '2px' });
      const branded = renderBlock(btn, document)!;
      expect(branded.style.background).toBe('rgb(20, 40, 200)');
      expect(branded.style.color).toBe('rgb(255, 255, 0)');
      expect(branded.style.borderRadius).toBe('2px');
      // Secondary/ghost stay inherit-first; only the radius is branded.
      const ghost = renderBlock({ ...btn, emphasis: 'ghost' }, document)!;
      expect(ghost.style.background).toBe('transparent');
      expect(ghost.style.borderRadius).toBe('2px');
    });
  });

  it('skips an unknown node type (newer server) instead of throwing', () => {
    expect(renderBlock({ type: 'carousel' } as never, document)).toBeNull();
    const el = renderBlock(
      { type: 'stack', direction: 'row', children: [{ type: 'carousel' } as never, { type: 'spacer', size: 'sm' }] },
      document,
    )!;
    expect(el.children.length).toBe(1); // partial arm beats broken page
  });
});

describe('applySlotBlocks — Option B reveal', () => {
  it('pre-renders every arm hidden and reveals the served one, hiding the originals', () => {
    const hero = document.getElementById('hero')!;
    applySlotBlocks(hero, { row: CTA_ROW, col: CTA_COL }, 'row', document);

    expect(wrapperFor(hero, 'row')!.style.display).toBe('');
    expect(wrapperFor(hero, 'col')!.style.display).toBe('none');
    expect((hero.querySelector('h1') as HTMLElement).style.display).toBe('none');
    expect((hero.querySelector('.sub') as HTMLElement).style.display).toBe('none');
  });

  it('a served arm without a tree (the baseline) reveals nothing and restores the originals', () => {
    const hero = document.getElementById('hero')!;
    applySlotBlocks(hero, { row: CTA_ROW }, 'row', document);
    expect((hero.querySelector('h1') as HTMLElement).style.display).toBe('none');

    applySlotBlocks(hero, { row: CTA_ROW }, 'baseline', document);
    expect(wrapperFor(hero, 'row')!.style.display).toBe('none');
    expect((hero.querySelector('h1') as HTMLElement).style.display).toBe('');
  });

  it('restores a pre-existing inline display exactly', () => {
    const hero = document.getElementById('hero')!;
    (hero.querySelector('.sub') as HTMLElement).style.display = 'inline-flex';
    applySlotBlocks(hero, { row: CTA_ROW }, 'row', document);
    applySlotBlocks(hero, { row: CTA_ROW }, undefined, document);
    expect((hero.querySelector('.sub') as HTMLElement).style.display).toBe('inline-flex');
  });

  it('is idempotent — repeated applies toggle, never duplicate wrappers', () => {
    const hero = document.getElementById('hero')!;
    applySlotBlocks(hero, { row: CTA_ROW, col: CTA_COL }, 'row', document);
    applySlotBlocks(hero, { row: CTA_ROW, col: CTA_COL }, 'col', document);
    applySlotBlocks(hero, { row: CTA_ROW, col: CTA_COL }, 'col', document);

    expect(hero.querySelectorAll(`[${BLOCK_ARM_ATTR}]`).length).toBe(2);
    expect(wrapperFor(hero, 'col')!.style.display).toBe('');
    expect(wrapperFor(hero, 'row')!.style.display).toBe('none');
  });

  it('removes a wrapper whose arm a newer publish dropped', () => {
    const hero = document.getElementById('hero')!;
    applySlotBlocks(hero, { row: CTA_ROW, col: CTA_COL }, 'row', document);
    applySlotBlocks(hero, { col: CTA_COL }, 'col', document);
    expect(wrapperFor(hero, 'row')).toBeNull();
    expect(wrapperFor(hero, 'col')!.style.display).toBe('');
  });
});

describe('applyRegistrySlots — blocks integration', () => {
  it('applies blocks on the pre-paint pass too (Option B is the no-flash mechanism)', () => {
    const slotConfig = {
      hero: { kind: 'arms' as const, target: '#hero', blocks: { row: CTA_ROW, col: CTA_COL } },
    };
    // contentAndOps:false = the pre-paint pass.
    applyRegistrySlots({ hero: 'col' }, slotConfig, document, { contentAndOps: false });

    const hero = document.getElementById('hero')!;
    expect(hero.getAttribute('data-sentient-arm')).toBe('col');
    expect(wrapperFor(hero, 'col')!.style.display).toBe('');
    expect(wrapperFor(hero, 'row')!.style.display).toBe('none');
    expect((hero.querySelector('h1') as HTMLElement).style.display).toBe('none');
  });

  it('a dims result reveals nothing (blocks are an arms-slot mechanism)', () => {
    const slotConfig = {
      hero: { kind: 'arms' as const, target: '#hero', blocks: { row: CTA_ROW } },
    };
    applyRegistrySlots({ hero: { tone: 'calm' } }, slotConfig, document, { contentAndOps: false });
    const hero = document.getElementById('hero')!;
    expect(wrapperFor(hero, 'row')!.style.display).toBe('none');
    expect((hero.querySelector('h1') as HTMLElement).style.display).toBe('');
  });
});

describe('teardown when a composition slot goes away', () => {
  // Blocks apply pre-paint from the snapshot, hiding the container's real
  // children. The only un-hide lived inside applySlotBlocks, reached only when
  // the response still carries `blocks` for that slot — so archiving a slot left
  // the merchant's own hero display:none for the whole page view.
  function seeded(): { container: HTMLElement; original: HTMLElement } {
    document.body.innerHTML = '<section id="hero"><h1 id="real">Real hero</h1></section>';
    const container = document.getElementById('hero')!;
    applySlotBlocks(
      container,
      { a: { type: 'stack', direction: 'column', children: [{ type: 'heading', level: 2, value: 'Variant hero' }] } },
      'a',
      document,
    );
    return { container, original: document.getElementById('real')! };
  }

  it('restores the merchant’s own content and removes the rendered arms', () => {
    const { container, original } = seeded();
    expect(original.style.display).toBe('none');
    expect(container.querySelector('[data-sentient-block-arm]')).toBeTruthy();

    restoreBlockContainer(container);

    expect(original.style.display).toBe('');
    expect(container.querySelector('[data-sentient-block-arm]')).toBeNull();
    expect(original.hasAttribute('data-sentient-blocks-hid')).toBe(false);
  });

  it('sweeps a container that is no longer served', () => {
    const { container, original } = seeded();
    // Decide came back with no blocks for this slot at all.
    sweepOrphanBlocks(document, new Set());
    expect(original.style.display).toBe('');
    expect(container.querySelector('[data-sentient-block-arm]')).toBeNull();
  });

  it('leaves a container that IS still being served alone', () => {
    const { container, original } = seeded();
    sweepOrphanBlocks(document, new Set([container]));
    expect(original.style.display).toBe('none');
    expect(container.querySelector('[data-sentient-block-arm]')).toBeTruthy();
  });

  it('preserves an inline display the merchant set themselves', () => {
    document.body.innerHTML = '<section id="hero"><h1 id="real" style="display:flex">Real</h1></section>';
    const container = document.getElementById('hero')!;
    applySlotBlocks(container, { a: { type: 'stack', direction: 'column', children: [{ type: 'heading', level: 2, value: 'V' }] } }, 'a', document);
    expect(document.getElementById('real')!.style.display).toBe('none');
    sweepOrphanBlocks(document, new Set());
    expect(document.getElementById('real')!.style.display).toBe('flex');
  });
});
