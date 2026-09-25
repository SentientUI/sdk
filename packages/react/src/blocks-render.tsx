import { cloneElement, Fragment, type CSSProperties, type JSX } from 'react';
import type { BlockNode, ComposeArm, FormBlock, SitePalette, StyleVocabulary } from '@sentientui/core';

/** A block's href/src, or undefined unless absolute https or a site-relative
 *  path — the rule the server validates (twin of the snippet's `safeBlockUrl`
 *  in ops.ts). The renderer is the last line: a stale config or a bypassed
 *  validator must not render `javascript:` into an <a> (audit S14). React
 *  itself only warns on `javascript:` URLs; it does not block them. */
function safeBlockUrl(v: unknown): string | undefined {
  // Whitespace/control chars rejected: browsers strip tab/newline, so
  // `/\t/evil.example` would become `//evil.example`.
  return typeof v === 'string' && !/[\s\x00-\x1f\\]/.test(v) && (/^https:\/\//i.test(v) || (v[0] === '/' && v[1] !== '/')) ? v : undefined;
}

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
  /** The site styles a Redesign tree borrows (native generation phase 2). */
  vocabulary?: StyleVocabulary | null;
  /** Absent handler = form trees must not reach this function (AdaptiveSlot gates). */
  onFormSubmit?: (values: Record<string, string>) => void;
  /** Fired with the form's submitGoal when a rendered form submits. */
  onFormGoal?: (goal: string) => void;
};

function toneStyles(tone: string | undefined, palette: SitePalette | null): CSSProperties {
  // Brand tokens when the palette carries them; the original neutral
  // fallbacks otherwise, so pre-token palettes render exactly as before.
  return {
    ...(tone === 'muted' ? (palette?.muted ? { color: palette.muted } : { opacity: 0.7 }) : {}),
    ...(tone === 'accent' ? { fontWeight: 600, ...(palette?.accent ? { color: palette.accent } : {}) } : {}),
  };
}

function buttonStyle(emphasis: string, palette: SitePalette | null, size?: string): CSSProperties {
  // Mirrors the snippet's button case (blocks.ts): palette tokens when
  // available, neutral inherit-first defaults otherwise. Secondary/ghost
  // resolve to the ACCENT — before brand tokens they rendered in
  // currentColor/inherit, which made every non-primary button look like
  // body text on brand-heavy sites.
  const accent = palette?.accent;
  return {
    display: 'inline-block',
    padding: BTN_PAD[size ?? 'md'] ?? BTN_PAD['md'],
    borderRadius: palette?.radius ?? '8px',
    font: 'inherit',
    ...(size ? { fontSize: FONT_SIZE[size] } : {}),
    textDecoration: emphasis === 'ghost' ? 'underline' : 'none',
    cursor: 'pointer',
    background: emphasis === 'primary' ? (palette?.primaryBg ?? '#111827') : 'transparent',
    color:
      emphasis === 'primary'
        ? (palette?.primaryText ?? '#ffffff')
        : (accent ?? 'inherit'),
    border: emphasis === 'secondary' ? `1px solid ${accent ?? 'currentColor'}` : 'none',
  };
}

function FormNode({ node, opts }: { node: FormBlock; opts: RenderBlocksOptions }): JSX.Element {
  const emphasis = node.emphasis ?? 'primary';
  const fieldStyle: CSSProperties = {
    padding: '8px 10px',
    font: 'inherit',
    border: `1px solid ${opts.palette?.border ?? 'currentColor'}`,
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
/** The site's own class list for a node that borrows one, or undefined —
 *  then the node renders with palette styling exactly as before (a dropped
 *  vocabulary entry degrades, never blanks). */
function classOf(node: BlockNode, opts: RenderBlocksOptions): string | undefined {
  const like = (node as { like?: string }).like;
  return like ? opts.vocabulary?.entries.find((e) => e.id === like)?.classes : undefined;
}

/** The measured text colour of a borrowed style whose class list doesn't set
 *  one (StyleEntry.computed.inheritsColor) — applied to the element, or it
 *  inherits whatever colour its new surroundings have. */
function inheritedColor(like: string | undefined, opts: RenderBlocksOptions): string | undefined {
  const e = like ? opts.vocabulary?.entries.find((x) => x.id === like) : undefined;
  return e?.computed.inheritsColor ? e.computed.color : undefined;
}

export function renderBlocks(node: BlockNode, opts: RenderBlocksOptions): JSX.Element | null {
  const el = renderOwn(node, opts);
  const color = inheritedColor((node as { like?: string }).like, opts);
  return el && color ? cloneElement(el, { style: { ...((el.props as { style?: CSSProperties }).style ?? {}), color } }) : el;
}

function renderOwn(node: BlockNode, opts: RenderBlocksOptions): JSX.Element | null {
  try {
    // A borrowed class list is the site's own styling: when it resolves, the
    // node keeps only LAYOUT styles (flex/grid/gap/pad/align, image fit,
    // measure) and none of the palette paint — colors, borders, radius and
    // type come from the site's CSS.
    const cls = classOf(node, opts);
    switch (node.type) {
      case 'stack': {
        // Same unknown-token fallback as the grid below (audit SNIP-11).
        const gap = GAP[node.gap ?? 'md'] ?? GAP['md'];
        // Rung 1: pad reuses the GAP scale; a raised stack with no pad
        // defaults to md (a zero-padding card is a design bug, not a choice).
        // Mirrors packages/snippet/src/blocks.ts — the drift-pin test is what
        // keeps the two renderers agreeing on these literals.
        const raised = node.surface === 'raised' && !cls;
        const pad = node.pad ?? (raised ? 'md' : undefined);
        return (
          <div
            {...(cls ? { className: cls } : {})}
            style={{
              display: 'flex',
              flexDirection: node.direction,
              gap,
              ...(node.align ? { alignItems: FLEX_POS[node.align] } : {}),
              ...(node.justify ? { justifyContent: FLEX_POS[node.justify] } : {}),
              ...(node.wrap ? { flexWrap: 'wrap' } : {}),
              ...(pad ? { padding: GAP[pad] ?? GAP['md'] } : {}),
              ...(raised
                ? {
                    ...(opts.palette?.surface ? { background: opts.palette.surface } : {}),
                    ...(opts.palette?.surface && opts.palette?.surfaceText ? { color: opts.palette.surfaceText } : {}),
                    border: `1px solid ${opts.palette?.border ?? 'currentColor'}`,
                    borderRadius: opts.palette?.radius ?? '8px',
                  }
                : {}),
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
            {...(cls ? { className: cls } : {})}
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fit, minmax(max(200px, calc((100% - ${node.columns - 1} * ${gap}) / ${node.columns})), 1fr))`,
              gap,
              ...(node.align ? { alignItems: FLEX_POS[node.align] } : {}),
              ...(node.pad ? { padding: GAP[node.pad] ?? GAP['md'] } : {}),
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
        if (cls) {
          return (
            <p className={cls} style={node.maxWidth === 'measure' ? { maxWidth: '65ch' } : undefined}>
              {node.value}
            </p>
          );
        }
        return (
          <p
            style={{
              margin: 0,
              ...(node.size ? { fontSize: FONT_SIZE[node.size] } : {}),
              ...(node.weight ? { fontWeight: WEIGHT[node.weight] } : {}),
              ...(node.align ? { textAlign: node.align } : {}),
              ...(node.maxWidth === 'measure' ? { maxWidth: '65ch' } : {}),
              ...toneStyles(node.tone, opts.palette),
            }}
          >
            {node.value}
          </p>
        );
      case 'heading': {
        const Tag = `h${node.level}` as 'h1' | 'h2' | 'h3' | 'h4';
        if (cls) {
          return (
            <Tag className={cls} style={node.maxWidth === 'measure' ? { maxWidth: '65ch' } : undefined}>
              {node.value}
            </Tag>
          );
        }
        return (
          <Tag
            style={{
              margin: 0,
              fontSize: HEADING_SIZE[node.size ?? 'md'],
              ...(node.align ? { textAlign: node.align } : {}),
              ...(node.maxWidth === 'measure' ? { maxWidth: '65ch' } : {}),
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
            href={safeBlockUrl(node.href)}
            {...(node.tag ? { 'data-sentient-tag': node.tag } : {})}
            {...(cls ? { className: cls } : { style: buttonStyle(emphasis, opts.palette, node.size) })}
          >
            {node.label}
          </a>
        );
      }
      case 'link':
        return (
          <a
            href={safeBlockUrl(node.href)}
            {...(node.tag ? { 'data-sentient-tag': node.tag } : {})}
            {...(cls ? { className: cls } : { style: { color: 'inherit', textDecoration: 'underline' } })}
          >
            {node.label}
          </a>
        );
      case 'image':
        return (
          <img
            src={safeBlockUrl(node.src)}
            alt={node.alt}
            {...(cls ? { className: cls } : {})}
            style={{
              display: 'block',
              maxWidth: '100%',
              ...(node.ratio && node.ratio !== 'auto' ? { aspectRatio: RATIO[node.ratio], width: '100%' } : {}),
              ...(node.fit ? { objectFit: node.fit } : {}),
            }}
          />
        );
      case 'badge':
        if (cls) return <span className={cls}>{node.value}</span>;
        return (
          <span
            style={{
              display: 'inline-block',
              padding: '2px 10px',
              borderRadius: '999px',
              fontSize: '0.75em',
              border: `1px solid ${opts.palette?.border ?? 'currentColor'}`,
              ...toneStyles(node.tone, opts.palette),
            }}
          >
            {node.value}
          </span>
        );
      case 'spacer':
        return <div style={{ height: SPACER[node.size] ?? SPACER['md'] }} />;
      case 'divider':
        // <hr> for semantics; border-top (not the default inset border) so the
        // hairline matches form fields and badges in the palette border color.
        return (
          <hr
            style={{
              border: 'none',
              borderTop: `1px solid ${opts.palette?.border ?? 'currentColor'}`,
              margin: 0,
              width: '100%',
            }}
          />
        );
      case 'form':
        return <FormNode node={node} opts={opts} />;
      default:
        return null; // newer-server node type — skip, never throw
    }
  } catch {
    return null; // fail-safe
  }
}

/**
 * A Redesign (compose) arm: the tree, painted on a site section/card surface
 * when its style resolves. Null when the tree's root can't render (a newer
 * server's node type) — the caller treats that like a blocked blocks arm.
 */
export function renderCompose(compose: ComposeArm, opts: RenderBlocksOptions): JSX.Element | null {
  const body = renderBlocks(compose.tree, opts);
  if (body === null) return null;
  const surface = compose.surface?.like ? opts.vocabulary?.entries.find((e) => e.id === compose.surface!.like)?.classes : undefined;
  const color = inheritedColor(compose.surface?.like, opts);
  return surface ? <div className={surface} {...(color ? { style: { color } } : {})}>{body}</div> : body;
}
