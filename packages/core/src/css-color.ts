// Browser colour normalization for capture (spec 2026-09-23 §4.1/§4.2).
// Chrome reports Tailwind v4 colours as `lab(…)` / `oklch(…)`, and the
// contrast math, the server's colour check and the prompts all read `rgb()`.
// Without this, a Tailwind v4 site's blue primary button had no measurable
// fill (captured as a secondary button), its grey body text had no colour
// (unusable under the contrast gate) and a slate gradient lost a stop —
// found on bodyshopmanchester.co.uk, 2026-09-23.
//
// The browser is the one colour-space converter that is always right, so the
// colour is painted to a 1×1 canvas and read back. No canvas (jsdom, some
// privacy modes) → '' for non-rgb input: unknown, which every consumer
// already treats as "not measured" rather than guessing.

const FN = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|#[0-9a-f]{3,8}\b/gi;
const RGB = /^rgba?\(\s*[\d.]+[,\s]+[\d.]+[,\s]+[\d.]+(?:[,\s/]+[\d.]+%?)?\s*\)$/i;

let ctx: CanvasRenderingContext2D | null | undefined;

function context(doc: Document): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  try {
    const c = doc.createElement('canvas');
    c.width = c.height = 1;
    ctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  } catch {
    ctx = null;
  }
  return ctx;
}

/** `rgb(r, g, b)` / `rgba(r, g, b, a)` for any CSS colour; '' when unknown. */
export function toRgb(color: string | null | undefined, doc: Document): string {
  const c = (color ?? '').trim();
  if (c === '' || c === 'transparent') return c === 'transparent' ? 'rgba(0, 0, 0, 0)' : '';
  if (RGB.test(c) || /^#[0-9a-f]{3,8}$/i.test(c)) return c;
  const g = context(doc);
  if (!g) return '';
  try {
    // A sentinel detects an unparsable value: assigning garbage to fillStyle
    // is silently ignored, which would otherwise read back the sentinel.
    g.fillStyle = '#010203';
    g.fillStyle = c;
    if (String(g.fillStyle).toLowerCase() === '#010203' && c.toLowerCase() !== '#010203') return '';
    g.clearRect(0, 0, 1, 1);
    g.fillRect(0, 0, 1, 1);
    const [r, gr, b, a] = g.getImageData(0, 0, 1, 1).data as unknown as number[];
    return a === 255 ? `rgb(${r}, ${gr}, ${b})` : `rgba(${r}, ${gr}, ${b}, ${Math.round((a! / 255) * 1000) / 1000})`;
  } catch {
    return '';
  }
}

/** Colour stops of a `background-image` gradient, normalized; [] for none. */
export function gradientStopsRgb(img: string | null | undefined, doc: Document): string[] {
  if (!img || img === 'none' || !/gradient/i.test(img)) return [];
  return (img.match(FN) ?? []).map((s) => toRgb(s, doc)).filter((s) => s !== '');
}

/** Test seam: forget the cached canvas context. */
export function resetColorCanvas(): void {
  ctx = undefined;
}
