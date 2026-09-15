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
// Rung 1 of the fully-design ladder (spec 2026-09-10 §4): containers can be
// cards ("raised" surface), containers get inner padding, and long copy can
// cap its measure. All token-resolved — no color/px props, same as ever.
export const BLOCK_SURFACES = ['default', 'raised'] as const;
export const BLOCK_PADS = ['none', 'sm', 'md', 'lg'] as const;
export const BLOCK_MAX_WIDTHS = ['measure'] as const;

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
export type BlockSurface = (typeof BLOCK_SURFACES)[number];
export type BlockPad = (typeof BLOCK_PADS)[number];
export type BlockMaxWidth = (typeof BLOCK_MAX_WIDTHS)[number];

/** Flex row/column container. `surface: 'raised'` renders it as a card
 *  (palette surface bg + border hairline + radius + readable text pairing);
 *  a raised stack with no `pad` defaults to `md` — a zero-padding card is a
 *  design bug both renderers refuse to reproduce. */
export type StackBlock = {
  type: 'stack';
  direction: 'row' | 'column';
  children: BlockNode[];
  gap?: BlockGap;
  align?: BlockAlign;
  justify?: BlockJustify;
  wrap?: boolean;
  surface?: BlockSurface;
  pad?: BlockPad;
};

/** 2–4 equal-column grid container. */
export type GridBlock = {
  type: 'grid';
  columns: (typeof BLOCK_GRID_COLUMNS)[number];
  children: BlockNode[];
  gap?: BlockGap;
  align?: BlockAlign;
  pad?: BlockPad;
};

/** Paragraph / label. `maxWidth: 'measure'` caps long copy at a readable 65ch. */
export type TextBlock = {
  type: 'text';
  value: string;
  size?: BlockSize;
  weight?: BlockWeight;
  tone?: BlockTone;
  align?: BlockTextAlign;
  maxWidth?: BlockMaxWidth;
};

/** h2–h4 — never h1 (the page owns its h1). */
export type HeadingBlock = {
  type: 'heading';
  value: string;
  level: (typeof BLOCK_HEADING_LEVELS)[number];
  size?: BlockSize;
  align?: BlockTextAlign;
  maxWidth?: BlockMaxWidth;
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

/** Section separation — a 1px hairline in the palette border color. No props:
 *  anything a divider could be configured with is a styling decision, and
 *  styling decisions live in tokens, not on nodes. */
export type DividerBlock = {
  type: 'divider';
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
  | DividerBlock
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
  /** Brand accent — resolves `tone: 'accent'` and secondary/ghost button color.
   *  Optional: sites tokenized before brand-token extraction shipped carry
   *  only the three fields above, and every renderer keeps its neutral
   *  fallback for them. */
  accent?: string;
  /** Readable text color on the accent (contrast-derived when not declared). */
  accentText?: string;
  /** Card/section background. */
  surface?: string;
  /** Readable text color on the surface (contrast-derived when not declared).
   *  Resolves the text pairing of `surface: 'raised'` stacks. */
  surfaceText?: string;
  /** Hairline border color (form fields, dividers). */
  border?: string;
  /** Muted text color — resolves `tone: 'muted'` (fallback: opacity 0.7). */
  muted?: string;
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
