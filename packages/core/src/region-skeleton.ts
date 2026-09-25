// Region skeleton (spec 2026-09-23 §4.1). The generator used to see a region
// as its flattened textContent — "Get in touch WhatsApp photos" — and wrote a
// heading + paragraph for what were two buttons. The skeleton is the region's
// STRUCTURE: every element that carries text, its role, link, emphasis and
// colour, so generation can write per-element edits and both SDKs can apply
// them to the developer's own elements.
//
// Only the wrapped region is ever read (same scope as baselineText); query
// strings and hashes never leave the page (tracking ids, sometimes PII).

export const MAX_SKELETON_NODES = 40;
export const MAX_SKELETON_LEAVES = 120;
export const MAX_SKELETON_TEXT = 300;

export type SkeletonRole = 'action' | 'heading' | 'text' | 'label' | 'image';
export type SkeletonNode = {
  tag: string;
  role: SkeletonRole;
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;            // joined normalized leaves of this node (image: alt)
  classes: string;         // class attribute, whitespace-normalized
  filled?: boolean;        // action only
  href?: string;           // action only; same-origin → path; else origin+path; never query/hash
  src?: string;            // image only; same rule
  color: string;           // computed `color`
  group: number;           // index of the node owner's parentElement among distinct parents
  restylable: boolean;     // snippet: always true; React: set by annotateSkeletonForReact
};
export type RegionSkeleton = {
  v: 1;
  root: { tag: string; classes: string; ambientBg: string | null; ambientBgAlt?: string; ambientText: string };
  nodes: SkeletonNode[];
  leaves: string[];        // normalized non-blank text leaves, document order
  leafToNode: number[];    // leaves[i] belongs to nodes[leafToNode[i]]
  fp: string;
  /** false = the page can't address these elements for per-element edits
   *  (React: the region wraps a component whose text the element tree can't
   *  see). The capture still describes the region — enough to REDESIGN it,
   *  which replaces the whole region — but no Rewrite arm may target it. */
  editable?: false;
};
export type ArmEdits = {
  nodes: Record<string, { text?: string; hidden?: true; like?: number }>;
  order?: Record<string, number[]>;
};
/** What the requesting page can render for one slot (decide `render` field). */
export type RenderCaps = {
  fp?: string;          // omitted = unknown (SSR): server assumes the stored skeleton
  forms: boolean;       // a form-arm handler exists
  compose: boolean;     // phase 2; always false in phase 1
  authored?: string[];  // phase 3
  content?: boolean;    // false = a content arm cannot land (0 or >1 text leaves). Omitted = true.
  children?: boolean;   // phase 3: false = no children to render, the first authored key is the baseline. Omitted = true.
};
/** How the server serves an `edits` arm (SlotConfigEntry.edits). */
export type ServedEdits = { edits: ArmEdits; fp: string; leafToNode: number[] };

// DOM capture lives in ./region-capture.ts, exported from
// `@sentientui/core/region`: only React and the snippet need it, and it would
// otherwise ship in the lean entry every plain-JS install downloads.
