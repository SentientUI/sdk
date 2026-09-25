// Browser sampler for the site style vocabulary (spec 2026-09-23 §4.2).
// Runs only in TRUSTED sessions — the on-site editor overlay and React pages
// opened from the dashboard with an editor token — and ships on its own
// subpath (`@sentientui/core/style-sample`), so no visitor bundle carries it.
//
// It reads the live page the way a designer would: which class lists the site
// actually uses for its buttons, headings, lead copy, cards and sections, with
// the computed colors that make a generated section's contrast judgeable.
// Classification is deterministic and computed-style based (the same approach
// as the palette sampler): no class-name guessing, so it works on Tailwind,
// BEM and hashed CSS-module names alike.
import type { SiteImage, StyleEntry, StyleRole } from './style-vocabulary.js';
import { gradientStopsRgb, toRgb } from './css-color.js';

type Sampled = Omit<StyleEntry, 'source'>;

const PER_ROLE = 4;
const BUTTON_DISPLAYS = new Set(['inline-block', 'block', 'flex', 'inline-flex']);
const HEADING_TAGS: Record<string, StyleRole> = { H1: 'heading-1', H2: 'heading-2', H3: 'heading-3' };

type RGBA = { r: number; g: number; b: number; a: number };

// The document being sampled: colours are normalized through it (lab()/
// oklch() → rgb via css-color.ts). Set once per sampleStyleVocabulary call.
let sampling: Document | null = null;

function parseColor(raw: string): RGBA | null {
  const c = sampling ? toRgb(raw, sampling) : raw;
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/i.exec(c);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
}

// WCAG relative luminance — duplicated from the API's contrastRatio on
// purpose: core can't import server code, and it's ten lines.
function luminance(c: RGBA): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

function contrast(a: RGBA, b: RGBA): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const painted = (c: string): boolean => {
  const p = parseColor(c);
  return p !== null && p.a > 0;
};

function gradientStops(img: string): string[] {
  if (!sampling) return [];
  return gradientStopsRgb(img, sampling);
}

const px = (v: string): number => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/** The painted background an element sits on (itself or nearest ancestor). */
function ambientBg(el: Element, view: Window): RGBA {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const cs = view.getComputedStyle(e);
    if (painted(cs.backgroundColor)) return parseColor(cs.backgroundColor)!;
    const stops = gradientStops(cs.backgroundImage);
    if (stops.length > 0) return parseColor(stops[0]!)!;
  }
  return { r: 255, g: 255, b: 255, a: 1 };
}

// Consent managers' own UI (Cookiebot, OneTrust, Usercentrics, CookieYes,
// Didomi, Quantcast, Complianz, Osano/cookieconsent, iubenda, TrustArc,
// Sourcepoint, Termly). Their buttons are the CMP's styling, not the site's.
const CMP_CONTAINER =
  '#CybotCookiebotDialog, #onetrust-consent-sdk, #usercentrics-root, #usercentrics-cmp-ui, .cky-consent-container, .cky-modal, #didomi-host, #qc-cmp2-container, #cmplz-cookiebanner-container, .cc-window, #cc-main, #iubenda-cs-banner, #truste-consent-track, [id^="sp_message_container"], #termly-code-snippet-support';

/**
 * Floating widgets (a cookie-settings pill, chat launcher, back-to-top) are
 * position:fixed and small; their styles are not the site's design system
 * (Bodyshop's cookie pill became a "main button", 2026-09-24). A full-width
 * fixed bar — a sticky header — IS site design and stays.
 */
function inFloatingWidget(el: Element, view: Window, vw: number): boolean {
  if (el.closest(CMP_CONTAINER)) return true;
  for (let e: Element | null = el; e && e !== el.ownerDocument.body; e = e.parentElement) {
    const pos = view.getComputedStyle(e).position;
    if (pos === 'fixed' || pos === 'sticky') {
      const w = e.getBoundingClientRect().width;
      return w > 0 && vw > 0 && w < 0.6 * vw;
    }
  }
  return false;
}

function hasOwnText(el: Element): boolean {
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3 && (n.nodeValue ?? '').trim() !== '') return true;
  return false;
}

function classify(el: Element, cs: CSSStyleDeclaration, ctx: { bodySize: number; pageBg: RGBA; bodyContrast: number; view: Window; vw: number }): StyleRole | null {
  const tag = el.tagName;
  const fontSize = px(cs.fontSize) || ctx.bodySize;
  const weight = Number(cs.fontWeight) || 400;
  const bgPainted = painted(cs.backgroundColor);
  const gradient = gradientStops(cs.backgroundImage).length > 0;
  const radius = px(cs.borderTopLeftRadius || cs.borderRadius);
  const width = el.getBoundingClientRect().width; // 0 = unknown (no layout, e.g. jsdom)

  const isButtonLike =
    tag === 'BUTTON' ||
    el.getAttribute('role') === 'button' ||
    (tag === 'INPUT' && /^(submit|button)$/i.test((el as HTMLInputElement).type)) ||
    (tag === 'A' && BUTTON_DISPLAYS.has(cs.display) && px(cs.paddingLeft) >= 8);
  if (isButtonLike) {
    // Icon-only controls (carousel arrows, menu toggles) aren't a style a
    // generated button can wear: 26 of them were Bodyshop's "ghost button".
    if ((el.textContent ?? '').trim() === '') return null;
    const bg = parseColor(cs.backgroundColor);
    // "Main" = a solid fill that stands out from what's behind it — not merely
    // a fill different from the <body>: Bodyshop's slate filter chips
    // (bg-slate-800/90 on a slate-900 section) were its "primary button".
    const behind = el.parentElement ? ambientBg(el.parentElement, ctx.view) : ctx.pageBg;
    if (bgPainted && bg && bg.a >= 0.9 && contrast(bg, behind) >= 1.5) return 'button-primary';
    if (bgPainted || px(cs.borderTopWidth) > 0) return 'button-secondary';
    return 'button-ghost';
  }
  if (tag === 'A') return 'link';
  if (HEADING_TAGS[tag]) return HEADING_TAGS[tag]!;
  if (hasOwnText(el) && fontSize >= 1.8 * ctx.bodySize && weight >= 600) {
    return fontSize >= 2.5 * ctx.bodySize ? 'heading-1' : fontSize >= 2 * ctx.bodySize ? 'heading-2' : 'heading-3';
  }
  // Eyebrow: small, tracked or uppercase, sitting right above a heading.
  const next = el.nextElementSibling;
  if (
    hasOwnText(el) &&
    fontSize <= 0.9 * ctx.bodySize &&
    (cs.textTransform === 'uppercase' || px(cs.letterSpacing) > 0.05 * fontSize) &&
    next !== null &&
    /^H[1-4]$/.test(next.tagName)
  ) {
    return 'eyebrow';
  }
  if (tag === 'UL' || tag === 'OL') return el.querySelectorAll(':scope > li').length >= 2 ? 'list' : null;
  if (tag === 'P' && hasOwnText(el)) {
    if (fontSize >= 1.1 * ctx.bodySize) return 'text-lead';
    if (fontSize <= 0.85 * ctx.bodySize) return 'text-small';
    const color = parseColor(cs.color);
    if (color && contrast(color, ambientBg(el, ctx.view)) < ctx.bodyContrast * 0.8) return 'text-muted';
    return 'text-body';
  }
  if ((tag === 'SPAN' || tag === 'DIV') && bgPainted && hasOwnText(el) && el.children.length === 0 && radius >= 999) return 'badge';
  if (/^(DIV|ARTICLE|LI|SECTION|ASIDE)$/.test(tag) && (bgPainted || gradient) && radius > 0 && px(cs.paddingTop) >= 16 && !(width > 0 && width >= 0.9 * ctx.vw)) {
    return 'card';
  }
  if (/^(SECTION|DIV|HEADER|MAIN|ASIDE)$/.test(tag) && (bgPainted || gradient) && el.querySelector('h1,h2,h3') !== null && (width === 0 || width >= 0.9 * ctx.vw)) {
    return 'section';
  }
  return null;
}

export function sampleStyleVocabulary(doc: Document, opts?: { maxElements?: number }): { entries: Sampled[]; images: SiteImage[] } {
  const view = doc.defaultView;
  if (!view || !doc.body) return { entries: [], images: [] };
  sampling = doc;
  const bodyCs = view.getComputedStyle(doc.body);
  const bodySize = px(bodyCs.fontSize) || 16;
  const pageBg = painted(bodyCs.backgroundColor) ? parseColor(bodyCs.backgroundColor)! : { r: 255, g: 255, b: 255, a: 1 };
  const bodyColor = parseColor(bodyCs.color) ?? { r: 17, g: 24, b: 39, a: 1 };
  const ctx = { bodySize, pageBg, bodyContrast: contrast(bodyColor, pageBg), view, vw: view.innerWidth || 0 };
  const url = view.location?.pathname ?? '/';
  const at = new Date().toISOString();

  const clusters = new Map<string, Sampled>(); // `${role}|${classes}`
  const area = new Map<string, number>(); // largest rendered instance per cluster
  const images = new Map<string, SiteImage>();
  const all = Array.from(doc.body.querySelectorAll('*')).slice(0, opts?.maxElements ?? 4000);
  for (const el of all) {
    try {
      if (el.tagName === 'IMG') {
        const img = el as HTMLImageElement;
        const alt = (img.getAttribute('alt') ?? '').trim();
        const w = img.naturalWidth || Number(img.getAttribute('width')) || 0;
        const h = img.naturalHeight || Number(img.getAttribute('height')) || 0;
        const raw = img.getAttribute('src');
        if (alt && w >= 200 && raw) {
          const src = new URL(raw, doc.baseURI).href;
          if (src.startsWith('https://') && !images.has(src)) {
            images.set(src, { id: `img-${images.size + 1}`, src, alt: alt.slice(0, 200), w, h, seenOn: url });
          }
        }
      }
      const classes = (el.getAttribute('class') ?? '').replace(/\s+/g, ' ').trim();
      if (classes === '') continue; // nothing to borrow
      if (inFloatingWidget(el, view, ctx.vw)) continue;
      const cs = view.getComputedStyle(el);
      const role = el.tagName === 'IMG' ? ((el.getAttribute('alt') ?? '').trim() ? 'image' : null) : classify(el, cs, ctx);
      if (!role) continue;
      const key = `${role}|${classes}`;
      const r = el.getBoundingClientRect();
      area.set(key, Math.max(area.get(key) ?? 0, r.width * r.height));
      const prev = clusters.get(key);
      if (prev) {
        prev.seen.count++;
        continue;
      }
      // Gradients: the contrast gate must judge text against the WORST stop,
      // so both stops are kept. `bg` = the lower-luminance stop, `bgDark` =
      // the other (the field name is historical, from the spec; the gate
      // checks both, so the order never affects correctness).
      const stops = gradientStops(cs.backgroundImage).map(parseColor).filter((c): c is RGBA => c !== null);
      let bg: string | undefined;
      let bgDark: string | undefined;
      if (painted(cs.backgroundColor)) bg = toRgb(cs.backgroundColor, doc);
      else if (stops.length > 0) {
        const sorted = [...stops].sort((a, b) => luminance(a) - luminance(b));
        const fmt = (c: RGBA) => (c.a < 1 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})` : `rgb(${c.r}, ${c.g}, ${c.b})`);
        bg = fmt(sorted[0]!);
        if (sorted.length > 1) bgDark = fmt(sorted[sorted.length - 1]!);
      }
      const radius = cs.borderTopLeftRadius || cs.borderRadius;
      clusters.set(key, {
        id: role,
        role,
        classes,
        computed: {
          ...(toRgb(cs.color, doc) ? { color: toRgb(cs.color, doc) } : {}),
          // Same colour as the parent: this class list doesn't set it (see
          // StyleEntry.computed.inheritsColor).
          ...(el.parentElement && view.getComputedStyle(el.parentElement).color === cs.color ? { inheritsColor: true as const } : {}),
          ...(bg ? { bg } : {}),
          ...(bgDark ? { bgDark } : {}),
          ...(cs.fontSize ? { fontSize: cs.fontSize } : {}),
          ...(cs.fontWeight ? { fontWeight: cs.fontWeight } : {}),
          ...(radius && px(radius) > 0 ? { radius } : {}),
        },
        seen: { url, count: 1, at },
      });
    } catch {
      // A hostile or exotic element never breaks sampling of the rest.
    }
  }

  // Keep each role's top class lists; ids role, role-2, …. Buttons rank by
  // rendered size, not repetition: a page's main CTA appears once, and by
  // count it lost to repeated chips and icons (Bodyshop's "Get in touch" was
  // never captured). Everything else ranks by how often the site uses it.
  const byRole = new Map<StyleRole, Sampled[]>();
  for (const e of clusters.values()) byRole.set(e.role, [...(byRole.get(e.role) ?? []), e]);
  const entries: Sampled[] = [];
  const sizeOf = (e: Sampled) => area.get(`${e.role}|${e.classes}`) ?? 0;
  for (const [role, list] of byRole) {
    list
      .sort((a, b) => (role.startsWith('button-') ? sizeOf(b) - sizeOf(a) : 0) || b.seen.count - a.seen.count)
      .slice(0, PER_ROLE)
      .forEach((e, i) => entries.push({ ...e, id: i === 0 ? role : `${role}-${i + 1}` }));
  }
  return { entries, images: [...images.values()] };
}
