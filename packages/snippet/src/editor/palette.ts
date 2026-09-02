// Site-palette sampling (Track B B3, spec §4 "derived, not chosen"; §13.4
// decided: automatic on editor open). Runs in the LAZY editor bundle — zero
// bytes on the normal path — from an operator's authenticated session, and the
// server total-validates what it stores, so a visitor never runs or receives
// anything this file touched directly.

export type SampledPalette = { primaryBg: string; primaryText: string; radius: string };

const TRANSPARENT_RE = /rgba\([^)]*,\s*0\s*\)$/;
const PX_RE = /^\d+(\.\d+)?px$/;

/**
 * Derive the site's primary-button look from the live page: among
 * button-shaped elements with a real (non-transparent, non-page) background,
 * the most frequent (background, color, radius) triple wins. Null when nothing
 * qualifies — the renderer's neutral defaults then stand, which is the correct
 * degradation for a site whose buttons we can't confidently read.
 */
export function deriveSitePalette(doc: Document): SampledPalette | null {
  try {
    const win = doc.defaultView;
    if (!win || !doc.body) return null;
    const bodyBg = win.getComputedStyle(doc.body).backgroundColor;
    const els = doc.querySelectorAll(
      'button, [role="button"], input[type="submit"], a[class*="btn" i], a[class*="button" i]',
    );
    const counts = new Map<string, number>();
    for (const el of Array.from(els).slice(0, 300)) {
      const rect = (el as HTMLElement).getBoundingClientRect();
      // Too small to be a CTA — but only when layout info exists (0×0 means
      // "unknown", e.g. jsdom or display:none; those fail the bg checks anyway).
      if (rect.width > 0 && (rect.width < 48 || rect.height < 24)) continue;
      const cs = win.getComputedStyle(el);
      const bg = cs.backgroundColor;
      if (!bg || bg === 'transparent' || bg === bodyBg || TRANSPARENT_RE.test(bg)) continue;
      const radius = (cs.borderRadius || '').split(' ')[0] ?? '';
      const key = `${bg}|${cs.color}|${PX_RE.test(radius) ? radius : '8px'}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let best: string | null = null;
    let n = 0;
    for (const [k, c] of counts) if (c > n) { best = k; n = c; }
    if (!best) return null;
    const [primaryBg, primaryText, radius] = best.split('|');
    return { primaryBg: primaryBg!, primaryText: primaryText!, radius: radius! };
  } catch {
    return null;
  }
}
