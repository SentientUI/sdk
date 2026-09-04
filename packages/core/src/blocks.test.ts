import { describe, expect, it } from 'vitest';
import {
  BLOCK_ALIGNS,
  BLOCK_EMPHASES,
  BLOCK_FITS,
  BLOCK_GAPS,
  BLOCK_GRID_COLUMNS,
  BLOCK_HEADING_LEVELS,
  BLOCK_JUSTIFIES,
  BLOCK_RATIOS,
  BLOCK_SIZES,
  BLOCK_TEXT_ALIGNS,
  BLOCK_TONES,
  BLOCK_WEIGHTS,
  MAX_BLOCK_ARMS,
  MAX_BLOCK_CHILDREN,
  MAX_BLOCK_DEPTH,
  MAX_BLOCK_NODES,
  MAX_BLOCK_TEXT_LEN,
} from './blocks';

// Drift pins for the composition-blocks contract. Three parties must agree on
// these values byte-for-byte: the server validator
// (apps/api/src/domain/composition-blocks.ts, which imports them from here),
// the snippet renderer (packages/snippet/src/blocks.ts, whose token→CSS maps
// are keyed by these strings), and the React renderer (§11). A drifted copy
// does not error — the fail-safe renders nothing for the unknown token, so a
// published arm ships with an INVISIBLY missing section. The literals are
// repeated here on purpose: editing blocks.ts alone must fail this test, which
// is the moment to go update the renderers' maps in the same change.
describe('composition blocks — structural caps', () => {
  it('pins the caps that bound one arm’s render cost and Option B’s DOM weight', () => {
    expect(MAX_BLOCK_NODES).toBe(64);
    expect(MAX_BLOCK_DEPTH).toBe(5);
    expect(MAX_BLOCK_CHILDREN).toBe(12);
    // DOM cost is arms × nodes (every arm pre-renders hidden) — raising the
    // arms cap multiplies page weight for every published composition arm.
    expect(MAX_BLOCK_ARMS).toBe(4);
    expect(MAX_BLOCK_TEXT_LEN).toBe(500);
  });
});

describe('composition blocks — token vocabularies', () => {
  it('pins every enumerated vocabulary exactly (order included)', () => {
    // Adding a token here without teaching the snippet/React renderers about
    // it means the server accepts trees those renderers silently degrade on;
    // removing one strands already-published arms. Order matters because the
    // validator's error messages and the builder's option lists follow it.
    expect(BLOCK_GAPS).toEqual(['none', 'sm', 'md', 'lg']);
    expect(BLOCK_ALIGNS).toEqual(['start', 'center', 'end', 'stretch']);
    expect(BLOCK_JUSTIFIES).toEqual(['start', 'center', 'end', 'between']);
    expect(BLOCK_SIZES).toEqual(['sm', 'md', 'lg']);
    expect(BLOCK_WEIGHTS).toEqual(['normal', 'medium', 'bold']);
    expect(BLOCK_TONES).toEqual(['default', 'muted', 'accent']);
    expect(BLOCK_EMPHASES).toEqual(['primary', 'secondary', 'ghost']);
    expect(BLOCK_TEXT_ALIGNS).toEqual(['left', 'center', 'right']);
    expect(BLOCK_RATIOS).toEqual(['auto', 'square', 'landscape', 'wide']);
    expect(BLOCK_FITS).toEqual(['cover', 'contain']);
    expect(BLOCK_GRID_COLUMNS).toEqual([2, 3, 4]);
    // Never 1 (h1 belongs to the page), never 5-6 (below the visual hierarchy).
    expect(BLOCK_HEADING_LEVELS).toEqual([2, 3, 4]);
  });
});
