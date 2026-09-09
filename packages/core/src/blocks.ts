/**
 * Composition Blocks (spec: 2026-08-20-nocode-composition-variants-design.md §4).
 *
 * A bounded, TYPED component tree — never HTML — that a registry arm may carry
 * (`published_config.arms[].blocks`). The vocabulary is the whitelist: every
 * prop value is an enumerated token, validated server-side before publish
 * (apps/api/src/domain/composition-blocks.ts) and rendered client-side through
 * document.createElement + property assignment only. No innerHTML/outerHTML/
 * insertAdjacentHTML exists anywhere on this path — the security property is
 * preserved by never accepting HTML, not by sanitizing it, which is why there
 * is no sanitizer to keep honest.
 *
 * Token lists live here (not in the API domain like SlotOps' mirrors) because
 * three parties must agree byte-for-byte: the server validator, the snippet
 * renderer, and eventually the React renderer (§11) — a drifted copy would let
 * a published arm fail to render, which the fail-safe turns into an invisibly
 * missing section, not an error.
 */

export const BLOCK_GAPS = ['none', 'sm', 'md', 'lg'] as const;
export const BLOCK_ALIGNS = ['start', 'center', 'end', 'stretch'] as const;
export const BLOCK_JUSTIFIES = ['start', 'center', 'end', 'between'] as const;
export const BLOCK_SIZES = ['sm', 'md', 'lg'] as const;
export const BLOCK_WEIGHTS = ['normal', 'medium', 'bold'] as const;
export const BLOCK_TONES = ['default', 'muted', 'accent'] as const;
export const BLOCK_EMPHASES = ['primary', 'secondary', 'ghost'] as const;
export const BLOCK_TEXT_ALIGNS = ['left', 'center', 'right'] as const;
export const BLOCK_RATIOS = ['auto', 'square', 'landscape', 'wide'] as const;
export const BLOCK_FITS = ['cover', 'contain'] as const;
export const BLOCK_GRID_COLUMNS = [2, 3, 4] as const;
export const BLOCK_HEADING_LEVELS = [2, 3, 4] as const;

export type BlockGap = (typeof BLOCK_GAPS)[number];
export type BlockAlign = (typeof BLOCK_ALIGNS)[number];
export type BlockJustify = (typeof BLOCK_JUSTIFIES)[number];
export type BlockSize = (typeof BLOCK_SIZES)[number];
export type BlockWeight = (typeof BLOCK_WEIGHTS)[number];
export type BlockTone = (typeof BLOCK_TONES)[number];
export type BlockEmphasis = (typeof BLOCK_EMPHASES)[number];
export type BlockTextAlign = (typeof BLOCK_TEXT_ALIGNS)[number];
export type BlockRatio = (typeof BLOCK_RATIOS)[number];
export type BlockFit = (typeof BLOCK_FITS)[number];

/** Flex row/column container. */
export type StackBlock = {
  type: 'stack';
  direction: 'row' | 'column';
  children: BlockNode[];
  gap?: BlockGap;
  align?: BlockAlign;
  justify?: BlockJustify;
  wrap?: boolean;
};

/** 2–4 equal-column grid container. */
export type GridBlock = {
  type: 'grid';
  columns: (typeof BLOCK_GRID_COLUMNS)[number];
  children: BlockNode[];
  gap?: BlockGap;
  align?: BlockAlign;
};

/** Paragraph / label. */
export type TextBlock = {
  type: 'text';
  value: string;
  size?: BlockSize;
  weight?: BlockWeight;
  tone?: BlockTone;
  align?: BlockTextAlign;
};

/** h2–h4 — never h1 (the page owns its h1). */
export type HeadingBlock = {
  type: 'heading';
  value: string;
  level: (typeof BLOCK_HEADING_LEVELS)[number];
  size?: BlockSize;
  align?: BlockTextAlign;
};

/** Link styled as a button. `tag` feeds agent legibility (agentDataByVariant). */
export type ButtonBlock = {
  type: 'button';
  label: string;
  href: string;
  emphasis?: BlockEmphasis;
  size?: BlockSize;
  tag?: string;
};

/** Inline text link. */
export type LinkBlock = {
  type: 'link';
  label: string;
  href: string;
  tag?: string;
};

/** Image. `alt` is required; empty only with an explicit `decorative: true`. */
export type ImageBlock = {
  type: 'image';
  src: string;
  alt: string;
  decorative?: boolean;
  ratio?: BlockRatio;
  fit?: BlockFit;
};

/** Eyebrow / pill. */
export type BadgeBlock = {
  type: 'badge';
  value: string;
  tone?: BlockTone;
};

/** Vertical rhythm. */
export type SpacerBlock = {
  type: 'spacer';
  size: BlockSize;
};

export const FORM_FIELD_KINDS = ['input', 'textarea', 'select'] as const;
export const FORM_INPUT_TYPES = ['text', 'email', 'number', 'tel'] as const;
export const MAX_FORM_FIELDS = 5;
export const MAX_FORM_SELECT_OPTIONS = 8;

/** One field of a form block. Fields are props, not child blocks, so an input
 *  can never appear outside a form — the constraint is structural, no
 *  validator has to chase it. */
export type FormField = {
  kind: (typeof FORM_FIELD_KINDS)[number];
  /** Slug key for the values object handed to onFormSubmit. */
  name: string;
  /** Visible label — required, a11y is not optional. */
  label: string;
  /** input fields only. Never password/file/hidden — the closed list is the guarantee. */
  inputType?: (typeof FORM_INPUT_TYPES)[number];
  required?: boolean;
  placeholder?: string;
  /** select fields only: 2–MAX_FORM_SELECT_OPTIONS plain-text options. */
  options?: string[];
};

/** Lead/contact form. Submit fires `submitGoal` (a project goal) and hands the
 *  values to the developer's onFormSubmit — field values never reach Sentient.
 *  At most one form per tree; a form is a leaf (no children). */
export type FormBlock = {
  type: 'form';
  submitGoal: string;
  submitLabel: string;
  fields: FormField[];
  emphasis?: BlockEmphasis;
};

export type BlockNode =
  | StackBlock
  | GridBlock
  | TextBlock
  | HeadingBlock
  | ButtonBlock
  | LinkBlock
  | ImageBlock
  | BadgeBlock
  | SpacerBlock
  | FormBlock;

/** The derived site palette (spec §4 "Colour and type: derived, not chosen").
 *  Sampled by the on-site editor from the live page's own buttons — computed
 *  styles, so values are plain colors (rgb/hex), never var()/url() — validated
 *  server-side, stored per project, and served with the decision so injected
 *  blocks render in the merchant's own primary color and corner radius.
 *  Absent → the renderer's neutral inherit-first defaults. */
export type SitePalette = {
  primaryBg: string;
  primaryText: string;
  radius: string;
};

// Structural caps. Total-nodes and depth bound the render cost of one arm;
// the arms cap bounds Option B's DOM weight (every arm pre-renders hidden, so
// DOM cost is arms × nodes — spec §6 proposed 4 and nothing has argued it up).
export const MAX_BLOCK_NODES = 64;
export const MAX_BLOCK_DEPTH = 5;
export const MAX_BLOCK_CHILDREN = 12;
export const MAX_BLOCK_ARMS = 4;
export const MAX_BLOCK_TEXT_LEN = 500;

/** True when the tree contains a form node at any depth. Surfaces that cannot
 *  render forms (snippet today, React without an onFormSubmit handler) must
 *  refuse the WHOLE tree — skipping just the form node would render a section
 *  minus its call-to-action, which looks live while converting nothing. */
export function containsFormBlock(node: unknown): boolean {
  if (node == null || typeof node !== 'object' || Array.isArray(node)) return false;
  const n = node as { type?: unknown; children?: unknown };
  if (n.type === 'form') return true;
  if (Array.isArray(n.children)) return n.children.some(containsFormBlock);
  return false;
}
