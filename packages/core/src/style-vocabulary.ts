//
// The site's own design system, as observed (spec 2026-09-23 §4.2). Every
// entry is a class list seen on ONE real element of the live site — which on a
// utility-CSS site is the only styling guaranteed to exist in the shipped CSS
// (Tailwind purges the rest). Composed arms borrow these by id instead of
// painting palette inline styles, which is what makes generated sections look
// native instead of "brand-colored generic".
import type { BlockNode } from './blocks.js';

export const STYLE_ROLES = [
  'button-primary', 'button-secondary', 'button-ghost', 'link',
  'heading-1', 'heading-2', 'heading-3', 'eyebrow',
  'text-lead', 'text-body', 'text-muted', 'text-small',
  'badge', 'card', 'section', 'image', 'list',
] as const;
export type StyleRole = (typeof STYLE_ROLES)[number];

/** A resolved vocabulary id. `node:k` and `role:x` are authoring forms the
 *  server resolves BEFORE persist — a stored or served tree only ever carries
 *  ids that match this. */
export const LIKE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

export const MAX_STYLE_ENTRIES = 60;
export const MAX_SITE_IMAGES = 40;

export type StyleEntry = {
  id: string;
  role: StyleRole;
  /** Exactly as observed on one element; validated server-side (validateClassList). */
  classes: string;
  /** Computed styles at observation time. Colors are what make the contrast
   *  gate judgeable; an entry without them can't carry text in a Redesign. */
  computed: {
    color?: string; bg?: string; bgDark?: string; fontSize?: string; fontWeight?: string; radius?: string;
    /** The text colour was INHERITED where this was sampled — the class list
     *  doesn't set it. Renderers apply `color` to the borrowing element, or
     *  the style reads in whatever colour its new surroundings inherit: a
     *  Bodyshop button captured white in its hero rendered black text inside
     *  the contact card (2026-09-24). */
    inheritsColor?: true;
  };
  seen: { url: string; count: number; at: string };
  source: 'editor' | 'crawl' | 'skeleton';
};

export type SiteImage = { id: string; src: string; alt: string; w: number; h: number; seenOn: string };

export type StyleVocabulary = { rev: string; entries: StyleEntry[]; images: SiteImage[] };

/** A Redesign arm: a composition tree whose visual nodes borrow site styles,
 *  optionally painted on a site section/card surface. */
export type ComposeArm = { surface?: { like: string }; tree: BlockNode };
