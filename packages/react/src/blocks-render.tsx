import { Fragment, type CSSProperties, type JSX } from 'react';
import type { BlockNode, FormBlock, SitePalette } from '@sentientui/core';

// React Composition Block renderer (spec 2026-09-08 empty-cell-generation §3).
// JSX from typed props ONLY — no dangerouslySetInnerHTML exists on this path,
// preserving the "no HTML ever accepted" security property. The server has
// total-validated every tree before publish; render still fail-safes per node
// (an unknown type from a NEWER server renders nothing rather than throwing,
// so a version-skewed bundle degrades to a partial arm, never a broken page —
// the same contract packages/snippet/src/blocks.ts pins in its tests).

// Token → CSS maps, ported verbatim from packages/snippet/src/blocks.ts:31-38.
// The drift-pin test in @sentientui/core blocks.test.ts is what keeps the three
// parties (server validator, snippet renderer, this file) agreeing.
const GAP: Record<string, string> = { none: '0', sm: '8px', md: '16px', lg: '24px' };
const FLEX_POS: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', between: 'space-between' };
const FONT_SIZE: Record<string, string> = { sm: '0.875em', md: '1em', lg: '1.25em' };
const HEADING_SIZE: Record<string, string> = { sm: '1.25em', md: '1.5em', lg: '2em' };
const BTN_PAD: Record<string, string> = { sm: '6px 14px', md: '10px 20px', lg: '14px 28px' };
const SPACER: Record<string, string> = { sm: '8px', md: '16px', lg: '32px' };
const RATIO: Record<string, string> = { square: '1 / 1', landscape: '4 / 3', wide: '16 / 9' };
const WEIGHT: Record<string, string> = { normal: '400', medium: '500', bold: '700' };

export type RenderBlocksOptions = {
  palette: SitePalette | null;
  /** Absent handler = form trees must not reach this function (AdaptiveSlot gates). */
  onFormSubmit?: (values: Record<string, string>) => void;
  /** Fired with the form's submitGoal when a rendered form submits. */
  onFormGoal?: (goal: string) => void;
};

function toneStyles(tone?: string): CSSProperties {
  return {
    ...(tone === 'muted' ? { opacity: 0.7 } : {}),
    ...(tone === 'accent' ? { fontWeight: 600 } : {}),
  };
}

function buttonStyle(emphasis: string, palette: SitePalette | null, size?: string): CSSProperties {
  // Mirrors the snippet's button case (blocks.ts:116-125): palette-primary
  // when available, neutral inherit-first defaults otherwise.
  return {
    display: 'inline-block',
    padding: BTN_PAD[size ?? 'md'] ?? BTN_PAD['md'],
    borderRadius: palette?.radius ?? '8px',
    font: 'inherit',
    ...(size ? { fontSize: FONT_SIZE[size] } : {}),
    textDecoration: emphasis === 'ghost' ? 'underline' : 'none',
    cursor: 'pointer',
    background: emphasis === 'primary' ? (palette?.primaryBg ?? '#111827') : 'transparent',
    color: emphasis === 'primary' ? (palette?.primaryText ?? '#ffffff') : 'inherit',
    border: emphasis === 'secondary' ? '1px solid currentColor' : 'none',
  };
}

function FormNode({ node, opts }: { node: FormBlock; opts: RenderBlocksOptions }): JSX.Element {
  const emphasis = node.emphasis ?? 'primary';
  const fieldStyle: CSSProperties = {
    padding: '8px 10px',
    font: 'inherit',
    border: '1px solid currentColor',
    borderRadius: opts.palette?.radius ?? '8px',
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const values: Record<string, string> = {};
        for (const f of node.fields) values[f.name] = String(data.get(f.name) ?? '');
        // Goal first: the conversion must be credited even if the site's own
        // handler throws — their bug must not cost them the learning signal.
        // Values go ONLY to the site's handler, never into any tracked payload.
        opts.onFormGoal?.(node.submitGoal);
        try {
          opts.onFormSubmit?.(values);
        } catch {
          /* site handler error is theirs to see in their own console */
        }
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
    >
      {node.fields.map((f) => (
        <label key={f.name} style={{ display: 'flex', flexDirection: 'column', gap: '4px', font: 'inherit' }}>
          {f.label}
          {f.kind === 'textarea' ? (
            <textarea name={f.name} required={f.required} placeholder={f.placeholder} rows={3} style={fieldStyle} />
          ) : f.kind === 'select' ? (
            <select name={f.name} required={f.required} style={fieldStyle}>
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              name={f.name}
              type={f.inputType ?? 'text'}
              required={f.required}
              placeholder={f.placeholder}
              style={fieldStyle}
            />
          )}
        </label>
      ))}
      <button type="submit" style={buttonStyle(emphasis, opts.palette)}>
        {node.submitLabel}
      </button>
    </form>
  );
}

/** Render one validated block tree as JSX. Null for anything unrenderable — fail-safe. */
export function renderBlocks(node: BlockNode, opts: RenderBlocksOptions): JSX.Element | null {
  try {
    switch (node.type) {
      case 'stack': {
        // Same unknown-token fallback as the grid below (audit SNIP-11).
        const gap = GAP[node.gap ?? 'md'] ?? GAP['md'];
        return (
          <div
            style={{
              display: 'flex',
              flexDirection: node.direction,
              gap,
              ...(node.align ? { alignItems: FLEX_POS[node.align] } : {}),
              ...(node.justify ? { justifyContent: FLEX_POS[node.justify] } : {}),
              ...(node.wrap ? { flexWrap: 'wrap' } : {}),
            }}
          >
            {(node.children ?? []).map((child, i) => {
              const rendered = renderBlocks(child, opts);
              return rendered === null ? null : <Fragment key={i}>{rendered}</Fragment>;
            })}
          </div>
        );
      }
      case 'grid': {
        // Responsive by construction — identical template to the snippet
        // (blocks.ts:84): auto-fit collapses on narrow screens, the calc()
        // floor keeps each item at an exact 1/columns share on wide ones.
        const gap = GAP[node.gap ?? 'md'] ?? GAP['md']!;
        return (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fit, minmax(max(200px, calc((100% - ${node.columns - 1} * ${gap}) / ${node.columns})), 1fr))`,
              gap,
              ...(node.align ? { alignItems: FLEX_POS[node.align] } : {}),
            }}
          >
            {(node.children ?? []).map((child, i) => {
              const rendered = renderBlocks(child, opts);
              return rendered === null ? null : <Fragment key={i}>{rendered}</Fragment>;
            })}
          </div>
        );
      }
      case 'text':
        return (
          <p
            style={{
              margin: 0,
              ...(node.size ? { fontSize: FONT_SIZE[node.size] } : {}),
              ...(node.weight ? { fontWeight: WEIGHT[node.weight] } : {}),
              ...(node.align ? { textAlign: node.align } : {}),
              ...toneStyles(node.tone),
            }}
          >
            {node.value}
          </p>
        );
      case 'heading': {
        const Tag = `h${node.level}` as 'h2' | 'h3' | 'h4';
        return (
          <Tag
            style={{
              margin: 0,
              fontSize: HEADING_SIZE[node.size ?? 'md'],
              ...(node.align ? { textAlign: node.align } : {}),
            }}
          >
            {node.value}
          </Tag>
        );
      }
      case 'button': {
        const emphasis = node.emphasis ?? 'primary';
        return (
          <a
            href={node.href}
            {...(node.tag ? { 'data-sentient-tag': node.tag } : {})}
            style={buttonStyle(emphasis, opts.palette, node.size)}
          >
            {node.label}
          </a>
        );
      }
      case 'link':
        return (
          <a
            href={node.href}
            {...(node.tag ? { 'data-sentient-tag': node.tag } : {})}
            style={{ color: 'inherit', textDecoration: 'underline' }}
          >
            {node.label}
          </a>
        );
      case 'image':
        return (
          <img
            src={node.src}
            alt={node.alt}
            style={{
              display: 'block',
              maxWidth: '100%',
              ...(node.ratio && node.ratio !== 'auto' ? { aspectRatio: RATIO[node.ratio], width: '100%' } : {}),
              ...(node.fit ? { objectFit: node.fit } : {}),
            }}
          />
        );
      case 'badge':
        return (
          <span
            style={{
              display: 'inline-block',
              padding: '2px 10px',
              borderRadius: '999px',
              fontSize: '0.75em',
              border: '1px solid currentColor',
              ...toneStyles(node.tone),
            }}
          >
            {node.value}
          </span>
        );
      case 'spacer':
        return <div style={{ height: SPACER[node.size] ?? SPACER['md'] }} />;
      case 'form':
        return <FormNode node={node} opts={opts} />;
      default:
        return null; // newer-server node type — skip, never throw
    }
  } catch {
    return null; // fail-safe
  }
}
