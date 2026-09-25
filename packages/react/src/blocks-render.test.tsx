import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { BlockNode, SitePalette } from '@sentientui/core';
import { renderBlocks } from './blocks-render.js';

const PALETTE: SitePalette = { primaryBg: 'rgb(17, 24, 39)', primaryText: 'rgb(255, 255, 255)', radius: '4px' };

const STACK: BlockNode = {
  type: 'stack',
  direction: 'column',
  gap: 'md',
  children: [
    { type: 'heading', value: 'Ship faster', level: 2 },
    { type: 'text', value: 'A paragraph.' },
    { type: 'button', label: 'Buy now', href: 'https://shop.example/buy', emphasis: 'primary' },
  ],
};

describe('renderBlocks', () => {
  it('renders a stack with heading, text, and palette-colored button', () => {
    const { container } = render(<div>{renderBlocks(STACK, { palette: PALETTE })}</div>);
    const root = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(root.style.display).toBe('flex');
    expect(root.querySelector('h2')!.textContent).toBe('Ship faster');
    expect(root.querySelector('p')!.textContent).toBe('A paragraph.');
    const btn = root.querySelector('a')! as HTMLAnchorElement;
    expect(btn.textContent).toBe('Buy now');
    expect(btn.href).toBe('https://shop.example/buy');
    expect(btn.style.background).toBe(PALETTE.primaryBg);
    expect(btn.style.borderRadius).toBe('4px');
  });

  it('brand tokens resolve tone and non-primary emphasis; bare palettes keep the neutral fallbacks', () => {
    const tokens: SitePalette = { ...PALETTE, accent: 'rgb(225, 29, 72)', muted: 'rgb(107, 114, 128)', border: 'rgb(229, 231, 235)' };
    const tree: BlockNode = {
      type: 'stack',
      direction: 'column',
      children: [
        { type: 'button', label: 'Compare', href: 'https://shop.example/c', emphasis: 'secondary' },
        { type: 'text', value: 'small print', tone: 'muted' },
        { type: 'badge', value: 'New', tone: 'accent' },
      ],
    };
    const { container } = render(<div>{renderBlocks(tree, { palette: tokens })}</div>);
    const btn = container.querySelector('a')! as HTMLAnchorElement;
    expect(btn.style.color).toBe('rgb(225, 29, 72)');
    expect(btn.style.border).toContain('rgb(225, 29, 72)');
    const p = container.querySelector('p')!;
    expect((p as HTMLElement).style.color).toBe('rgb(107, 114, 128)');
    const badge = container.querySelector('span')! as HTMLElement;
    expect(badge.style.color).toBe('rgb(225, 29, 72)');
    expect(badge.style.fontWeight).toBe('600');
    expect(badge.style.border).toContain('rgb(229, 231, 235)');

    // Without tokens, the same tree keeps the pre-token neutral look.
    const { container: bare } = render(<div>{renderBlocks(tree, { palette: PALETTE })}</div>);
    const bareBtn = bare.querySelector('a')! as HTMLAnchorElement;
    expect(bareBtn.style.color).toBe('inherit');
    expect(bareBtn.style.border.toLowerCase()).toContain('currentcolor');
    expect((bare.querySelector('p') as HTMLElement).style.opacity).toBe('0.7');
  });

  it('rung 1: raised surface, pad, divider, maxWidth mirror the snippet renderer', () => {
    const tokens: SitePalette = {
      ...PALETTE,
      surface: 'rgb(243, 244, 246)', surfaceText: 'rgb(17, 24, 39)', border: 'rgb(229, 231, 235)',
    };
    const tree: BlockNode = {
      type: 'stack',
      direction: 'column',
      surface: 'raised',
      children: [
        { type: 'heading', value: 'Pro plan', level: 3, maxWidth: 'measure' },
        { type: 'divider' },
        { type: 'text', value: 'Everything in Starter.' },
      ],
    };
    const { container } = render(<div>{renderBlocks(tree, { palette: tokens })}</div>);
    const card = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(card.style.background).toBe('rgb(243, 244, 246)');
    expect(card.style.color).toBe('rgb(17, 24, 39)');
    expect(card.style.border).toContain('rgb(229, 231, 235)');
    expect(card.style.borderRadius).toBe('4px');
    // Raised without an explicit pad defaults to md — same rule as the snippet.
    expect(card.style.padding).toBe('16px');
    expect((card.querySelector('h3') as HTMLElement).style.maxWidth).toBe('65ch');
    const hr = card.querySelector('hr') as HTMLElement;
    expect(hr.style.borderTop).toContain('rgb(229, 231, 235)');

    // Without surface tokens: no color guess — hairline + radius only.
    const { container: bare } = render(<div>{renderBlocks(tree, { palette: null })}</div>);
    const bareCard = bare.firstElementChild!.firstElementChild as HTMLElement;
    expect(bareCard.style.background).toBe('');
    expect(bareCard.style.color).toBe('');
    expect(bareCard.style.border.toLowerCase()).toContain('currentcolor');
  });

  it('renders hostile text as inert literal text — never markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { container } = render(<div>{renderBlocks({ type: 'text', value: hostile }, { palette: null })}</div>);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe(hostile);
  });

  it('skips an unknown node type while siblings survive (fail-safe contract)', () => {
    const tree = {
      type: 'stack',
      direction: 'row',
      children: [{ type: 'carousel' } as never, { type: 'spacer', size: 'sm' }],
    } as BlockNode;
    const { container } = render(<div>{renderBlocks(tree, { palette: null })}</div>);
    const root = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(root.children.length).toBe(1); // partial arm beats broken section
    expect(renderBlocks({ type: 'carousel' } as never, { palette: null })).toBeNull();
  });

  it('renders a grid with the snippet-identical responsive template', () => {
    const tree: BlockNode = {
      type: 'grid',
      columns: 3,
      gap: 'sm',
      children: [
        { type: 'badge', value: 'A' },
        { type: 'badge', value: 'B' },
        { type: 'badge', value: 'C' },
      ],
    };
    const { container } = render(<div>{renderBlocks(tree, { palette: null })}</div>);
    const root = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(root.style.display).toBe('grid');
    expect(root.style.gridTemplateColumns).toBe(
      'repeat(auto-fit, minmax(max(200px, calc((100% - 2 * 8px) / 3)), 1fr))',
    );
  });

  it('renders a form with labeled fields and fires goal-first on submit', () => {
    const onFormSubmit = vi.fn();
    const onFormGoal = vi.fn();
    const tree: BlockNode = {
      type: 'form',
      submitGoal: 'lead_capture',
      submitLabel: 'Get the report',
      fields: [
        { kind: 'input', name: 'work_email', label: 'Work email', inputType: 'email', required: true },
        { kind: 'select', name: 'team_size', label: 'Team size', options: ['1-10', '11-50', '50+'] },
        { kind: 'textarea', name: 'notes', label: 'Notes' },
      ],
    };
    const { getByLabelText, getByRole, container } = render(
      <div>{renderBlocks(tree, { palette: PALETTE, onFormSubmit, onFormGoal })}</div>,
    );

    const email = getByLabelText('Work email') as HTMLInputElement;
    expect(email.type).toBe('email');
    expect(email.required).toBe(true);
    const select = getByLabelText('Team size') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['1-10', '11-50', '50+']);
    expect(getByLabelText('Notes').tagName).toBe('TEXTAREA');
    expect(getByRole('button').textContent).toBe('Get the report');

    fireEvent.change(email, { target: { value: 'a@b.co' } });
    fireEvent.change(select, { target: { value: '1-10' } });
    fireEvent.submit(container.querySelector('form')!);

    expect(onFormGoal).toHaveBeenCalledWith('lead_capture');
    expect(onFormSubmit).toHaveBeenCalledWith({ work_email: 'a@b.co', team_size: '1-10', notes: '' });
  });

  it('credits the goal even when the site handler throws', () => {
    const onFormGoal = vi.fn();
    const onFormSubmit = vi.fn(() => {
      throw new Error('their bug');
    });
    const tree: BlockNode = {
      type: 'form',
      submitGoal: 'lead_capture',
      submitLabel: 'Send',
      fields: [{ kind: 'input', name: 'x', label: 'X' }],
    };
    const { container } = render(<div>{renderBlocks(tree, { palette: null, onFormSubmit, onFormGoal })}</div>);
    expect(() => fireEvent.submit(container.querySelector('form')!)).not.toThrow();
    expect(onFormGoal).toHaveBeenCalledWith('lead_capture');
  });
});

describe('renderBlocks — URL schemes (audit S14)', () => {
  it('renders https and site-relative targets, drops anything else', () => {
    const href = (h: string) => {
      const { container } = render(<>{renderBlocks({ type: 'link', label: 'x', href: h } as BlockNode, { palette: null })}</>);
      return container.querySelector('a')!.getAttribute('href');
    };
    expect(href('https://example.com/p')).toBe('https://example.com/p');
    expect(href('/pricing')).toBe('/pricing');
    expect(href('javascript:alert(1)')).toBeNull();
    expect(href('//evil.example')).toBeNull();
    const { container } = render(<>{renderBlocks({ type: 'image', src: 'javascript:1', alt: 'a' } as BlockNode, { palette: null })}</>);
    expect(container.querySelector('img')!.getAttribute('src')).toBeNull();
  });
});
