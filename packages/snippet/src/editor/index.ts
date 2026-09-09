import { resolveLocatorOne } from '../locator';
import { generateLocator, resolvesUniquely } from './locator-gen';
import { clearCachedEditorToken } from '../editor-token';
import { deriveSitePalette } from './palette';
import { CSS_PROP, cssValueSafe } from '../css-guard';
import { applyOps } from '../ops';
import {
  buildDraftPayload, funnelSummaryLine, stepOptions, toggleStepSelection,
  type EditorFunnel, type EditorGoal,
} from './funnel-panel';
import type { CompoundLocator, SlotOps } from '@sentientui/core';

// On-site visual editor overlay. Loaded as a SEPARATE bundle only when the
// snippet detects ?sentient_editor=<token>. It reads its token + API base from
// window.__sentientEditor (set by the snippet), verifies the token, then lets a
// non-technical user click an element, save a DRAFT (text test, style, or move),
// and — the on-site golden path — Publish it live without leaving the page.
// Publishing is slot-only and server-validated/versioned (reversible from the
// dashboard); goals still save as drafts, and pins/analytics stay dashboard-only.

type Boot = { token: string; apiBase: string };

// Deterministic 32-bit hash (djb2 → base36) for slot-id uniqueness. Not crypto —
// just a stable short suffix so distinct elements never collide.
function hash36(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** Stable, unique, human-readable slot id per (element, kind). Stable across
 *  repeat edits of the same element (so re-editing updates the same draft), yet
 *  distinct across elements and kinds — which is what stops multiple reorders
 *  from overwriting one shared `reorder-slot` id. */
export function deriveSlotId(kind: 'text' | 'style' | 'move' | 'arrange', locator: CompoundLocator, el: Element): string {
  const handle =
    (locator.id) ||
    (locator.dataAttr?.value) ||
    (el.textContent ?? '').trim() ||
    el.tagName;
  const slug = slugify(handle) || 'el';
  const suffix = hash36(JSON.stringify(locator));
  const id = `${kind}-${slug}-${suffix}`;
  return id.slice(0, 128);
}

// Mirrors apps/api/src/domain/site-audit-targets.ts's AuditTarget — kept as a
// local structural type so the snippet package doesn't depend on the API.
export type AuditTarget = {
  id: string; kind: 'form' | 'cta' | 'button' | 'headline' | 'image';
  pageUrl: string; label: string; locator: CompoundLocator;
  confidence: 'high' | 'medium'; evidence: string[];
};

const HIGHLIGHT_ID = 'sentient-editor-highlight';
const SELECTION_ID = 'sentient-editor-selection';
const PANEL_ID = 'sentient-editor-panel';
const TOAST_ID = 'sentient-editor-toast';
const STYLE_ID = 'sentient-editor-styles';
const TARGET_HIGHLIGHT_CLASS = 'sentient-editor-target-highlight';
const MAX_TARGET_HIGHLIGHTS = 10;
const EXPIRED_MESSAGE = 'Editor session expired. Reopen it from your dashboard to keep editing — your saved changes are safe.';
// Any non-401 load failure (cold API worker, network blip, CORS). Distinct from
// EXPIRED_MESSAGE — no "expired", and it invites a retry — because reopening (or
// just reloading) may well succeed once the transient condition clears.
const LOAD_ERROR_MESSAGE = 'Couldn’t load the editor — check your connection and reopen it from your dashboard.';

// One-time keyframes so the panel announces itself on load — people were opening
// editor mode and not noticing the small corner panel. Motion (a slide-in + a
// brief indigo halo pulse) is the strongest "I'm over here" cue; it settles after
// a few seconds so it never nags. All of it is disabled under reduced-motion.
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
@keyframes sntedi-in {
  from { opacity: 0; transform: translateY(28px) scale(0.94); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes sntedi-attn {
  0%, 100% { box-shadow: 0 10px 34px rgba(0,0,0,0.45), 0 0 0 0 rgba(99,102,241,0); }
  50%      { box-shadow: 0 10px 34px rgba(0,0,0,0.55), 0 0 0 7px rgba(99,102,241,0.40); }
}
@keyframes sntedi-dot {
  0%, 100% { box-shadow: 0 0 0 0 rgba(52,211,153,0.55); }
  50%      { box-shadow: 0 0 0 5px rgba(52,211,153,0); }
}
#${PANEL_ID} {
  animation: sntedi-in 0.42s cubic-bezier(0.2,0.9,0.25,1.15) both,
             sntedi-attn 1.7s ease-in-out 0.42s 3;
}
#${PANEL_ID} .sntedi-dot { animation: sntedi-dot 1.4s ease-in-out infinite; }
#${TOAST_ID} { animation: sntedi-in 0.42s cubic-bezier(0.2,0.9,0.25,1.15) both; }
@media (prefers-reduced-motion: reduce) {
  #${PANEL_ID}, #${PANEL_ID} .sntedi-dot, #${TOAST_ID} { animation: none !important; }
}
`;
  (document.head ?? document.documentElement).appendChild(style);
}

/** A small amber notice pinned bottom-right — used when the editor token is
 *  expired/invalid (a 401). Click to dismiss; auto-dismisses so it never lingers.
 *  Distinct from the panel: it appears when there is no panel (load-time expiry). */
function showToast(message: string): void {
  ensureStyles();
  document.getElementById(TOAST_ID)?.remove();
  const toast = el('div', {
    position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483647',
    maxWidth: '320px', padding: '14px 16px', borderRadius: '14px',
    background: '#111827', color: '#fff', font: '13px/1.45 system-ui, sans-serif',
    border: '1px solid rgba(245,158,11,0.6)', boxShadow: '0 10px 34px rgba(0,0,0,0.45)',
    display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer',
  });
  toast.id = TOAST_ID;
  const dot = el('span', {
    width: '9px', height: '9px', marginTop: '4px', borderRadius: '50%',
    background: '#f59e0b', flex: '0 0 auto',
  });
  toast.append(dot, el('div', {}, message));
  (document.body ?? document.documentElement).appendChild(toast);
  toast.addEventListener('click', () => toast.remove());
  setTimeout(() => toast.remove(), 10000);
}

function boot(): Boot | null {
  const b = (window as unknown as { __sentientEditor?: Boot }).__sentientEditor;
  return b && typeof b.token === 'string' && typeof b.apiBase === 'string' ? b : null;
}

// `unauthorized` (a 401) means the token is expired or invalid — distinct from a
// transient network error, so callers can say "session expired" only when true.
type VerifyResult = { ok: true; projectId: string } | { ok: false; unauthorized: boolean };

async function verify(b: Boot): Promise<VerifyResult> {
  try {
    const res = await fetch(`${b.apiBase}/v1/editor/verify`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    if (res.status === 401) return { ok: false, unauthorized: true };
    if (!res.ok) return { ok: false, unauthorized: false };
    const projectId = ((await res.json()) as { projectId?: string }).projectId;
    return projectId ? { ok: true, projectId } : { ok: false, unauthorized: false };
  } catch {
    return { ok: false, unauthorized: false };
  }
}

// 'expired' is a 401 (token no longer valid) vs. 'error' for anything else, so the
// panel can tell the user their retry won't help until they reopen the editor.
type SaveResult = 'ok' | 'expired' | 'error';

/** A save's full outcome. The server sends machine codes (`error`, `message`,
 *  `feature`) with every failure; collapsing them to a bare 'error' rendered
 *  "try again" to a merchant whose real answer was "your plan's live-goal
 *  limit is 1" — deterministically futile retries hiding the one message that
 *  mattered. Callers pass the whole outcome to reportSave, never a string. */
type SaveOutcome = {
  r: SaveResult;
  status?: number;
  code?: string;
  message?: string;
  feature?: string;
  plan?: string;
};

function outcomeFrom(status: number, body: Record<string, unknown> | null): SaveOutcome {
  return {
    r: status === 401 ? 'expired' : 'error',
    status,
    ...(typeof body?.error === 'string' ? { code: body.error } : {}),
    ...(typeof body?.message === 'string' ? { message: body.message } : {}),
    ...(typeof body?.feature === 'string' ? { feature: body.feature } : {}),
    ...(typeof body?.plan === 'string' ? { plan: body.plan } : {}),
  };
}

async function save(b: Boot, path: string, body: unknown): Promise<SaveOutcome> {
  try {
    const res = await fetch(`${b.apiBase}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return { r: 'ok' };
    const errBody = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return outcomeFrom(res.status, errBody);
  } catch {
    return { r: 'error' };
  }
}

/** Authenticated editor-scope DELETE. No content-type header — the request
 *  has no body, and Fastify 400s a bodyless request that claims JSON (the
 *  same trap the MCP client hit). */
async function del(b: Boot, path: string): Promise<SaveOutcome> {
  try {
    const res = await fetch(`${b.apiBase}${path}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${b.token}` },
    });
    if (res.ok) return { r: 'ok' };
    const errBody = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return outcomeFrom(res.status, errBody);
  } catch {
    return { r: 'error' };
  }
}

/** Authenticated editor-scope POST that needs the response BODY (the plain
 *  save() reports only the outcome). Parses the body even on a 4xx so a
 *  validation reason can be surfaced verbatim. */
async function saveJson<T>(b: Boot, path: string, body: unknown): Promise<{ r: SaveResult; data: T | null; outcome: SaveOutcome }> {
  try {
    const res = await fetch(`${b.apiBase}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as T | null;
    if (res.ok) return { r: 'ok', data, outcome: { r: 'ok' } };
    return { r: res.status === 401 ? 'expired' : 'error', data, outcome: outcomeFrom(res.status, data as Record<string, unknown> | null) };
  } catch {
    return { r: 'error', data: null, outcome: { r: 'error' } };
  }
}

/** Font families the site already loads, per the audit (targets endpoint).
 *  Module-scope and filled lazily after mount — the style form reads it at
 *  open time, so the label upgrades once the fetch lands. */
let detectedFonts: string[] = [];

/** <input type=color> only accepts #rrggbb; sampled palette colors arrive as
 *  computed rgb()/rgba() strings and AI suggestions as anything the server's
 *  style guard passes (#fff, space-form rgb, hsl, named colors). Unparseable
 *  values pass through unchanged — callers that feed a color INPUT must check
 *  isHex6 first: assigning a non-hex value to <input type=color> silently
 *  coerces it to #000000, and the input's own 'input' event then flags it
 *  touched — the exact stealth black fill the touched flag exists to prevent. */
export function isHex6(c: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(c);
}
export function toHexColor(c: string): string {
  const v = c.trim();
  if (isHex6(v)) return v;
  const m3 = /^#([0-9a-fA-F]{3})$/.exec(v);
  if (m3) return `#${m3[1]!.split('').map((ch) => ch + ch).join('')}`;
  // Comma or space separated: rgb(11, 61, 145) and rgb(11 61 145) both occur.
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  if (!m) return v;
  const h = (n: string): string => Math.min(255, Number(n)).toString(16).padStart(2, '0');
  return `#${h(m[1]!)}${h(m[2]!)}${h(m[3]!)}`;
}

/** Site palette sampled at editor open — reused as style-form swatches so the
 *  operator starts from the site's own colors, not #000000. */
let sitePalette: { primaryBg: string; primaryText: string; radius: string } | null = null;

/** Audit-detected targets, shared with mount()'s keyboard handler: Tab cycles
 *  through whichever of them resolve on the current page — the one keyboard
 *  route into element picking (everything else is mousemove/click). Filled by
 *  start() after the targets fetch lands; empty means Tab keeps its normal
 *  focus behavior. */
let keyboardTargets: AuditTarget[] = [];
export function registerAuditTargets(targets: AuditTarget[]): void {
  keyboardTargets = targets;
}

async function fetchTargets(b: Boot): Promise<AuditTarget[]> {
  try {
    const res = await fetch(`${b.apiBase}/v1/editor/targets`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { targets?: AuditTarget[]; fonts?: string[] };
    detectedFonts = Array.isArray(body.fonts) ? body.fonts.filter((f): f is string => typeof f === 'string') : [];
    return Array.isArray(body.targets) ? body.targets : [];
  } catch {
    return [];
  }
}

/** Authenticated editor-scope GET — null on any failure (the caller shows a
 *  friendly status line instead of a broken panel). */
async function fetchEditorJson<T>(b: Boot, path: string): Promise<T | null> {
  try {
    const res = await fetch(`${b.apiBase}${path}`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Remove any pre-highlight outlines drawn by drawTargetHighlights (best-effort hints
 *  clear as soon as the user starts hovering to pick their own element). */
export function clearTargetHighlights(doc: Document = document): void {
  for (const node of Array.from(doc.querySelectorAll(`.${TARGET_HIGHLIGHT_CLASS}`))) node.remove();
}

/**
 * Draw non-interactive, labeled outline boxes over audit-detected targets that
 * resolve on the current page — "This is your main headline" style hints.
 * Best-effort: unresolved locators are silently skipped, capped at
 * MAX_TARGET_HIGHLIGHTS. Boxes are pointer-events:none so they never intercept
 * clicks/moves — the existing capture-phase listeners keep working underneath.
 */
export function drawTargetHighlights(targets: AuditTarget[], doc: Document = document): void {
  clearTargetHighlights(doc);
  let drawn = 0;
  for (const target of targets) {
    if (drawn >= MAX_TARGET_HIGHLIGHTS) break;
    const resolved = resolveLocatorOne(target.locator, doc);
    if (!resolved) continue;
    const r = resolved.getBoundingClientRect();

    const box = el('div', {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483645',
      left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
      border: '2px dashed #10b981', background: 'rgba(16,185,129,0.08)',
    });
    box.className = TARGET_HIGHLIGHT_CLASS;

    const chip = el('div', {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483645',
      left: `${r.left}px`, top: `${Math.max(0, r.top - 20)}px`,
      padding: '2px 6px', borderRadius: '4px', background: '#10b981', color: '#fff',
      font: '11px system-ui, sans-serif', whiteSpace: 'nowrap',
    }, target.label);
    chip.className = TARGET_HIGHLIGHT_CLASS;

    (doc.body ?? doc.documentElement).append(box, chip);
    drawn += 1;
  }
}

/** Fresh sibling anchors from the element's CURRENT position. Call on selection
 *  AND after each move so chained moves never reuse stale neighbors. A locator is
 *  returned only when the sibling resolves uniquely (else Save would no-op). */
export function computeMoveAnchors(el: Element, doc: Document): {
  prevEl: Element | null; nextEl: Element | null;
  prevLocator: CompoundLocator | null; nextLocator: CompoundLocator | null;
} {
  const prevEl = el.previousElementSibling;
  const nextEl = el.nextElementSibling;
  const prevLoc = prevEl ? generateLocator(prevEl, doc) : null;
  const nextLoc = nextEl ? generateLocator(nextEl, doc) : null;
  return {
    prevEl,
    nextEl,
    prevLocator: prevEl && prevLoc && resolvesUniquely(prevLoc, prevEl, doc) ? prevLoc : null,
    nextLocator: nextEl && nextLoc && resolvesUniquely(nextLoc, nextEl, doc) ? nextLoc : null,
  };
}

export type StyleControls = {
  color?: string; background?: string; fontSize?: string;
  fontWeight?: string; borderRadius?: string; textAlign?: string; fontFamily?: string;
};

/** What the selected section actually contains, harvested from its own DOM. */
export type SectionCopy = {
  headings: string[];
  paragraphs: string[];
  links: Array<{ label: string; href: string }>;
  quotes: string[];
  attributions: string[];
};

/** Class/id smell for a testimonial block that uses no <blockquote>. */
const TESTIMONIAL_HINT = /testimonial|review|quote/i;

/**
 * Which catalog section types this section may be re-laid-out as.
 *
 * The catalog is a set of LAYOUTS for content the page already has, not a
 * library of sections to add. Offering all of them regardless of the selection
 * is what let someone drop a testimonials block onto a site with no
 * testimonials — the arrangement then filled itself from the catalog's own
 * placeholder copy ("Alex P., Founder, Example Co."), so the site shipped
 * invented quotes from people who don't exist.
 *
 * So each type is gated on evidence in the section itself:
 * - hero / cta_band: a heading AND something to click. Both are "headline +
 *   supporting line + button" shapes, so a section with either missing has
 *   nothing to re-arrange into one.
 * - feature_grid: repeated titled blurbs — at least two headings and two
 *   paragraphs.
 * - testimonial: an actual quote. Never inferred from anything weaker.
 *
 * Returns the types in catalog order. An empty result is a legitimate answer:
 * this section has no alternative layout, which the caller says out loud.
 */
export function sectionTypesFor(copy: SectionCopy): string[] {
  const out: string[] = [];
  const hasHeading = copy.headings.length >= 1;
  const hasAction = copy.links.length >= 1;
  if (hasHeading && hasAction) out.push('hero', 'cta_band');
  if (copy.headings.length >= 2 && copy.paragraphs.length >= 2) out.push('feature_grid');
  if (copy.quotes.length >= 1) out.push('testimonial');
  return out;
}

const STYLE_KEYS = ['color', 'background', 'fontSize', 'fontWeight', 'borderRadius', 'textAlign', 'fontFamily'] as const;

// Semantic validation ON TOP of the shared injection-safety guard (cssValueSafe).
// A value can be injection-safe yet illegal CSS — `fontSize:"20"` (no unit),
// `textAlign:"centre"`, `color:"reddish"` — which the browser silently drops,
// so a "✓ Saved" toast would be a lie. These catch those per property.
const LENGTH_RE = /^(0|\d*\.?\d+(px|rem|em|%|vh|vw|vmin|vmax|ch|pt))$/i;
const TEXT_ALIGN = new Set(['left', 'center', 'right', 'justify', 'start', 'end']);
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FN_RE = /^(rgb|rgba|hsl|hsla)\(/i;
// A named-colour allow-list would be huge; the picker uses <input type="color">
// (always a valid hex), so free-text colours only reach here via a paste. Accept
// hex or a colour function, otherwise ask for a hex — never claim a bad value saved.
function isValidColor(v: string): boolean {
  return HEX_RE.test(v) || COLOR_FN_RE.test(v);
}

/** Returns a short, user-facing reason `v` is not a legal value for `key`, or
 *  null when it is valid. Only called for non-empty, injection-safe values. */
export function styleFieldError(key: (typeof STYLE_KEYS)[number], v: string): string | null {
  switch (key) {
    case 'fontSize':
    case 'borderRadius':
      return LENGTH_RE.test(v) ? null : 'Add a unit, e.g. 20px or 1.5rem.';
    case 'fontWeight':
      return /^(normal|bold|bolder|lighter)$/i.test(v) || (/^\d{1,4}$/.test(v) && +v >= 1 && +v <= 1000)
        ? null : 'Use 100–900, or normal/bold.';
    case 'textAlign':
      return TEXT_ALIGN.has(v.toLowerCase()) ? null : 'Choose left, center, right, or justify.';
    case 'color':
    case 'background':
      return isValidColor(v) ? null : 'Enter a colour, e.g. #1a1a1a.';
    case 'fontFamily': {
      // Mirrors the server rule (slot-registry): 1–5 comma-separated families,
      // plain names only — a font can be referenced, never loaded.
      const families = v.split(',').map((f) => f.trim().replace(/^['"]|['"]$/g, ''));
      return v.length <= 120 && families.length >= 1 && families.length <= 5 &&
        families.every((f) => /^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(f))
        ? null : 'Use a font name, e.g. Georgia, serif.';
    }
    default:
      return null;
  }
}

/** Friendly controls → { style, errors }. Only whitelisted keys survive (they
 *  match ops.ts CSS_PROP). Empty fields are skipped (no change). A value that is
 *  unsafe or illegal CSS for its property lands in `errors` (for per-field
 *  feedback) rather than being silently dropped behind a false "Saved". */
export function buildStyleOps(c: StyleControls): { style: Record<string, string>; errors: Record<string, string> } {
  const style: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const key of STYLE_KEYS) {
    const raw = c[key];
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (v === '') continue; // unset field — no change, no error
    if (!cssValueSafe(v)) { errors[key] = 'That value isn’t allowed.'; continue; }
    const err = styleFieldError(key, v);
    if (err) { errors[key] = err; continue; }
    style[key] = v;
  }
  return { style, errors };
}

function el(tag: string, style: Partial<CSSStyleDeclaration>, text?: string): HTMLElement {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text !== undefined) node.textContent = text; // never innerHTML
  return node;
}

export function mount(b: Boot): void {
  let selected: Element | null = null;

  // --- editor telemetry (spec 2026-09-06 §05) -----------------------------
  // The editor measures every customer funnel and none of its own. Batched,
  // debounced, fire-and-forget: a failed flush drops the batch silently —
  // telemetry must never block or break editing. Enum kinds + scalar meta
  // only; the server enforces the same bounds.
  type TelemetryMeta = Record<string, string | number | boolean>;
  const telemetryQueue: Array<{ kind: string; meta?: TelemetryMeta }> = [];
  let telemetryTimer: ReturnType<typeof setTimeout> | null = null;
  const flushTelemetry = (): void => {
    // Drain the WHOLE queue in server-sized batches (the route caps a request
    // at 20 events): a single splice stranded events 21+ until the next
    // debounce — permanently, when the flush was the pagehide one.
    while (telemetryQueue.length > 0) {
      const events = telemetryQueue.splice(0, 20);
      try {
        void fetch(`${b.apiBase}/v1/editor/telemetry`, {
          method: 'POST',
          keepalive: true,
          headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ events }),
        }).catch(() => undefined);
      } catch { /* fail-safe */ }
    }
  };
  const emit = (kind: string, meta?: TelemetryMeta): void => {
    telemetryQueue.push({ kind, ...(meta ? { meta } : {}) });
    if (telemetryTimer) clearTimeout(telemetryTimer);
    telemetryTimer = setTimeout(flushTelemetry, 2000);
  };
  // A hard close (tab gone) would lose the debounced batch without this.
  window.addEventListener('pagehide', flushTelemetry);

  const highlight = el('div', {
    position: 'fixed', pointerEvents: 'none', zIndex: '2147483646',
    border: '2px solid #6366f1', background: 'rgba(99,102,241,0.12)', display: 'none',
  });
  highlight.id = HIGHLIGHT_ID;

  // The SELECTION ring is separate from the hover highlight: it stays pinned on
  // the chosen element while the mouse travels to the panel, so the user never
  // loses track of what their edit/goal applies to (the reported confusion).
  const selectionRing = el('div', {
    position: 'fixed', pointerEvents: 'none', zIndex: '2147483646',
    border: '2px solid #10b981', background: 'rgba(16,185,129,0.10)',
    borderRadius: '4px', display: 'none',
  });
  selectionRing.id = SELECTION_ID;
  const positionSelectionRing = (): void => {
    if (!selected || !selected.isConnected) { selectionRing.style.display = 'none'; return; }
    const r = selected.getBoundingClientRect();
    Object.assign(selectionRing.style, {
      display: 'block', left: `${r.left - 2}px`, top: `${r.top - 2}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
  };
  const onReposition = (): void => positionSelectionRing();

  ensureStyles();

  const panel = el('div', {
    position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483647',
    // min(): 408px of room on desktop, but never wider than the viewport —
    // the preview bar already clamps to 90vw; a fixed 408 + the 16px offset
    // overflowed a 390px phone with no way to reach the left edge.
    width: 'min(408px, calc(100vw - 32px))', padding: '16px', borderRadius: '14px', background: '#111827', color: '#fff',
    font: '13px/1.4 system-ui, sans-serif', border: '1px solid rgba(99,102,241,0.55)',
    boxShadow: '0 10px 34px rgba(0,0,0,0.45)',
    // Anchored at the bottom, the panel grows UPWARD — with ~12 base buttons
    // plus the 8-entry arrangement catalog plus a 7-field form, the top left
    // the viewport entirely and there was no way to scroll to it, so clicking
    // a layout appeared to do nothing (the form rendered off-screen).
    maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', overscrollBehavior: 'contain',
  });
  panel.id = PANEL_ID;

  // Header: a pulsing green "live" dot + the product name — signals at a glance
  // that editor mode is actually on.
  const dot = el('span', {
    width: '9px', height: '9px', borderRadius: '50%', background: '#34d399',
    display: 'inline-block', flex: '0 0 auto',
  });
  dot.className = 'sntedi-dot';
  const title = el('div', {
    display: 'flex', alignItems: 'center', gap: '8px',
    fontWeight: '700', fontSize: '14px', marginBottom: '6px',
  });
  title.append(dot, el('span', {}, 'SentientUI'));
  const hint = el('div', { opacity: '0.85', marginBottom: '8px' }, 'Click any element on the page to adapt it.');
  // Pause/resume element picking: while paused the capture-phase handlers
  // early-return, so clicks and hovers reach the site untouched — links
  // navigate, menus open, forms work. Function-local, so a re-mount after a
  // navigation always starts unpaused (you navigated to get somewhere; now
  // you pick).
  let pickingPaused = false;
  const pauseBtn = el('button', btnStyle('#374151'), 'Pause selecting') as HTMLButtonElement;
  pauseBtn.onclick = () => {
    pickingPaused = !pickingPaused;
    pauseBtn.textContent = pickingPaused ? 'Resume selecting' : 'Pause selecting';
    if (pickingPaused) {
      highlight.style.display = 'none';
      clearTargetHighlights(document);
      setStatus('Selection paused — browse normally, then resume.');
    } else {
      setStatus('Click any element on the page to adapt it.');
    }
  };
  // Which element the actions below apply to — pinned in the panel so it never
  // gets lost while the mouse is over here.
  const selectedLabel = el('div', {
    fontSize: '12px', marginBottom: '6px', padding: '5px 8px', borderRadius: '8px',
    background: 'rgba(16,185,129,0.14)', border: '1px solid rgba(16,185,129,0.45)',
    display: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  });
  const status = el('div', { fontSize: '12px', marginBottom: '8px', minHeight: '16px' });

  const textBtn = el('button', btnStyle('#6366f1'), 'Test different text here') as HTMLButtonElement;
  const styleBtn = el('button', btnStyle('#374151'), 'Change style') as HTMLButtonElement;
  // Arrangement picker (Track B B3, spec §7 step 2): test a catalog layout
  // against the selected section — the section stays the control, and only
  // layouts that fit what the section already contains are offered
  // (sectionTypesFor).
  const arrangeBtn = el('button', btnStyle('#374151'), 'Try a different layout for this section') as HTMLButtonElement;
  const goalBtn = el('button', btnStyle('#374151'), 'Track clicks as a goal') as HTMLButtonElement;
  // Only shown when the selected element sits inside a <form> — tracks the form.
  const formGoalBtn = el('button', btnStyle('#374151'), 'Track form submissions as a goal') as HTMLButtonElement;
  // Always available (needs no selection): counts visitors reaching this page.
  const pageGoalBtn = el('button', btnStyle('#374151'), 'Track page visits as a goal') as HTMLButtonElement;
  // Always available (needs no selection): counts reading this far down the page.
  const scrollGoalBtn = el('button', btnStyle('#374151'), 'Track reading this far as a goal') as HTMLButtonElement;
  // Funnels (spec §7.3): build a multi-step funnel from tracked goals and
  // attach the slot being edited to a step — all without the dashboard.
  const funnelBtn = el('button', btnStyle('#374151'), 'Set up a funnel') as HTMLButtonElement;
  const attachFunnelBtn = el('button', btnStyle('#374151'), 'Attach this test to a funnel step') as HTMLButtonElement;
  const publishFunnelBtn = el('button', btnStyle('#10b981'), 'Turn the funnel on') as HTMLButtonElement;
  const moveUpBtn = el('button', btnStyle('#374151'), 'Move up') as HTMLButtonElement;
  const moveDownBtn = el('button', btnStyle('#374151'), 'Move down') as HTMLButtonElement;
  const saveArrangeBtn = el('button', btnStyle('#6366f1'), 'Save this arrangement') as HTMLButtonElement;
  const undoBtn = el('button', btnStyle('#374151'), 'Undo') as HTMLButtonElement;
  const closeBtn = el('button', { ...btnStyle('transparent'), opacity: '0.6' }, 'Close editor') as HTMLButtonElement;
  // Publishing a just-saved draft live — the on-site golden path (no dashboard
  // round-trip). Hidden until a slot draft is saved this session.
  const publishBtn = el('button', btnStyle('#10b981'), 'Publish now — go live') as HTMLButtonElement;
  // Same golden path for goals: saved drafts activate right here.
  const activateGoalBtn = el('button', btnStyle('#10b981'), 'Start tracking now') as HTMLButtonElement;
  for (const btn of [textBtn, styleBtn, arrangeBtn, goalBtn, moveUpBtn, moveDownBtn]) (btn as HTMLButtonElement).disabled = true;
  // Element actions stay HIDDEN until something is selected — a wall of greyed
  // buttons was the "messy" part; pre-selection the panel is just the hint plus
  // the page-visit goal (which needs no element).
  const elementButtons = [textBtn, styleBtn, arrangeBtn, goalBtn, formGoalBtn, moveUpBtn, moveDownBtn];
  for (const btn of elementButtons) btn.style.display = 'none';
  saveArrangeBtn.style.display = 'none';
  undoBtn.style.display = 'none';
  publishBtn.style.display = 'none';
  activateGoalBtn.style.display = 'none';

  attachFunnelBtn.style.display = 'none';
  publishFunnelBtn.style.display = 'none';
  // Ancestor breadcrumb under the selection label: selecting a SECTION used to
  // mean clicking its padding without hitting a child — coordinate work for a
  // script, silent mis-selection for a human. Crumbs reselect by level instead.
  const crumbHost = el('div', {
    display: 'none', fontSize: '11px', opacity: '0.75', marginBottom: '2px',
    lineHeight: '1.8', overflow: 'hidden', textOverflow: 'ellipsis',
  });
  // Host for the non-unique-selection recovery card (see selectElement).
  const suggestHost = el('div', {});

  // ---- Tabbed panel (editor UX phase 2) ----------------------------------
  // The panel used to be one column of ~15 stacked buttons under small-caps
  // labels; every operator saw every action at once and the column was the
  // reason the height cap exists. Tabs show ONE concern at a time; the Text
  // and Style tabs open their form directly (fewest clicks), the others hold
  // their few actions. Buttons keep their own show/hide + disabled semantics —
  // the tab layer only decides which group is on screen.
  type TabId = 'text' | 'style' | 'layout' | 'goals' | 'funnels' | 'drafts';
  const TAB_DEFS: Array<{ id: TabId; label: string; icon: string }> = [
    { id: 'text', label: 'Text', icon: '✏️' },
    { id: 'style', label: 'Style', icon: '🎨' },
    { id: 'layout', label: 'Layout', icon: '🧱' },
    { id: 'goals', label: 'Goals', icon: '🎯' },
    { id: 'funnels', label: 'Funnels', icon: '🧭' },
    { id: 'drafts', label: 'Drafts', icon: '🗂️' },
  ];
  let activeTab: TabId = 'text';
  const tabButtons = new Map<TabId, HTMLButtonElement>();
  const tabPanes = new Map<TabId, HTMLElement>();
  const tabHints = new Map<TabId, HTMLElement>();

  const tabBar = el('div', {
    display: 'flex', gap: '0', margin: '10px 0 0', justifyContent: 'space-between',
    borderBottom: '1px solid rgba(255,255,255,0.1)',
  });
  const paneHost = el('div', { paddingTop: '10px' });
  for (const t of TAB_DEFS) {
    const tb = el('button', {
      background: 'transparent', border: 'none', cursor: 'pointer',
      font: '600 11.5px system-ui, sans-serif', color: '#9ca3af', whiteSpace: 'nowrap',
      padding: '7px 5px', borderBottom: '2px solid transparent', marginBottom: '-1px',
    }) as HTMLButtonElement;
    // Icon in its own span so it keeps full color while the LABEL dims for
    // inactive tabs (emoji ignore the button's color property).
    tb.append(el('span', { fontSize: '11px', marginRight: '3px' }, t.icon), el('span', {}, t.label));
    tb.onclick = () => setActiveTab(t.id);
    tabButtons.set(t.id, tb);
    tabBar.append(tb);
    const pane = el('div', { display: 'none' });
    const paneHint = el('div', { fontSize: '12px', opacity: '0.7', padding: '2px 0 6px', display: 'none' });
    pane.append(paneHint);
    tabHints.set(t.id, paneHint);
    tabPanes.set(t.id, pane);
    paneHost.append(pane);
  }
  tabPanes.get('text')!.append(textBtn);
  tabPanes.get('style')!.append(styleBtn);
  tabPanes.get('layout')!.append(arrangeBtn, moveUpBtn, moveDownBtn, saveArrangeBtn, undoBtn);
  // activateGoalBtn lives in the FOOTER (with the review card + publish), not
  // here — the post-save verbs sit together regardless of the active tab.
  tabPanes.get('goals')!.append(goalBtn, formGoalBtn, pageGoalBtn, scrollGoalBtn);
  tabPanes.get('funnels')!.append(funnelBtn, attachFunnelBtn, publishFunnelBtn);
  const draftsList = el('div', {});
  tabPanes.get('drafts')!.append(draftsList);

  const renderActiveTab = (): void => {
    for (const t of TAB_DEFS) {
      const on = t.id === activeTab;
      const tb = tabButtons.get(t.id)!;
      tb.style.color = on ? '#ffffff' : '#9ca3af';
      tb.style.borderBottom = on ? '2px solid #6366f1' : '2px solid transparent';
      tabPanes.get(t.id)!.style.display = on ? 'block' : 'none';
      tabHints.get(t.id)!.style.display = 'none';
    }
    const hintFor = (msg: string): void => {
      const h = tabHints.get(activeTab)!;
      h.textContent = msg;
      h.style.display = 'block';
    };
    // Text and Style open their form directly — a tab whose whole content is
    // one button was an extra click for nothing. Both paths run only from an
    // explicit transition (tab click / new selection), after closeForm, so an
    // in-progress form is never clobbered by a re-render.
    if (activeTab === 'text') {
      if (!selected) hintFor('Click any text on the page to test a different wording.');
      else if (textBtn.disabled) hintFor(textBtn.title || 'This element can’t be targeted reliably — try its heading or a button.');
      else textBtn.onclick?.(new MouseEvent('click') as never);
    } else if (activeTab === 'style') {
      if (!selected) hintFor('Click any element on the page to change how it looks.');
      else if (styleBtn.disabled) hintFor('This element can’t be targeted reliably — try a heading, a button, or a whole section.');
      else styleBtn.onclick?.(new MouseEvent('click') as never);
    } else if (activeTab === 'layout') {
      if (!selected) hintFor('Click a section to move it or lay it out differently. Layouts re-arrange the words already on the page — they never add a section you don’t have.');
    } else if (activeTab === 'goals') {
      if (!selected) hintFor('Page-level goals work right away; click a button or form to track it specifically.');
    } else if (activeTab === 'funnels') {
      hintFor('Chain tracked goals into a journey — the drop-off view fills in as visitors move through it.');
    } else if (activeTab === 'drafts') {
      void renderDrafts();
    }
  };

  // Drafts tab: every saved test with an in-editor Preview — the per-arm
  // preview mode existed but was only reachable from the dashboard, so saved
  // work vanished from view and previewing meant a round-trip.
  // Two-step discard arming on the button itself: first press asks ("Sure?"),
  // second within 4s runs. No native confirm — a blocking dialog would freeze
  // the page the editor overlays.
  const armTwoStep = (btn: HTMLButtonElement, label: string, run: () => void): void => {
    btn.onclick = () => {
      if (btn.dataset.armed === '1') { btn.dataset.armed = ''; run(); return; }
      btn.dataset.armed = '1';
      btn.textContent = 'Sure?';
      setTimeout(() => {
        if (btn.isConnected && btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = label; }
      }, 4000);
    };
  };

  const smallBtn = (bg: string, label: string): HTMLButtonElement =>
    el('button', {
      ...btnStyle(bg), display: 'inline-block', width: 'auto', margin: '0',
      padding: '4px 9px', fontSize: '11px', flex: '0 0 auto',
    }, label) as HTMLButtonElement;

  /** Leave for the per-arm preview, keeping the cached token so the preview
   *  bar's "Back to editor" returns here. Shared by the Drafts rows and the
   *  review card. */
  const gotoPreview = (slotId: string, arm?: string): void => {
    const url = new URL(window.location.href);
    url.searchParams.delete('sentient_editor');
    url.searchParams.set('sentient_preview', slotId);
    if (arm) url.searchParams.set('sentient_arm', arm);
    window.location.assign(url.toString());
  };

  /** A Discard button wired to a draft-delete endpoint: two-step, disabled
   *  while in flight, reports through the shared failure mapping. */
  const discardBtn = (path: string, okMsg: string, done: () => void): HTMLButtonElement => {
    const btn = smallBtn('#374151', 'Discard');
    armTwoStep(btn, 'Discard', async () => {
      btn.disabled = true;
      const r = await del(b, path);
      btn.disabled = false;
      reportSave(r, okMsg);
      if (r.r === 'ok') done();
    });
    return btn;
  };

  /** Post-save review card (spec §2.2): what was created, that nothing is
   *  live yet, and the verbs that act on it. One shape for slots and goals —
   *  a goal has nothing to render, so it just gets no preview verb. */
  const renderReviewCard = (message: string, verbs: HTMLElement[]): void => {
    reviewHost.textContent = '';
    const card = el('div', {
      margin: '0 0 6px', padding: '8px 10px', borderRadius: '8px', fontSize: '12px',
      background: 'rgba(99,102,241,0.10)', border: '1px solid rgba(99,102,241,0.35)',
    });
    const row = el('div', { display: 'flex', gap: '6px', flexWrap: 'wrap' });
    row.append(...verbs);
    card.append(el('div', { marginBottom: '6px' }, message), row);
    reviewHost.append(card);
  };

  type DraftGoal = { goal_id: string; display_name: string | null; event: string; status: string };
  const renderDrafts = async (): Promise<void> => {
    draftsList.textContent = '';
    draftsList.append(el('div', { fontSize: '12px', opacity: '0.6', padding: '4px 0' }, 'Loading…'));
    let rows: Array<{ slot_id: string; display_name: string | null; status: string; draft_config: { arms?: Array<{ id: string }> } | null; published_config: { arms?: Array<{ id: string }> } | null }> = [];
    let goals: DraftGoal[] = [];
    // A failed load must NOT render the empty state: "Nothing saved yet" after
    // a network blip (or an expired token) reads as "your drafts are gone".
    let loadFailed: 'expired' | 'error' | null = null;
    let goalsFailed = false;
    await Promise.all([
      (async () => {
        try {
          const res = await fetch(`${b.apiBase}/v1/editor/slots`, { headers: { authorization: `Bearer ${b.token}` } });
          if (res.ok) rows = ((await res.json()) as { slots?: typeof rows }).slots ?? [];
          else loadFailed = res.status === 401 ? 'expired' : 'error';
        } catch { loadFailed = 'error'; }
      })(),
      (async () => {
        try {
          const res = await fetch(`${b.apiBase}/v1/editor/goals`, { headers: { authorization: `Bearer ${b.token}` } });
          if (res.ok) goals = ((await res.json()) as { goals?: DraftGoal[] }).goals ?? [];
          else goalsFailed = true;
        } catch { goalsFailed = true; }
      })(),
    ]);
    if (activeTab !== 'drafts') return; // the operator moved on mid-fetch
    draftsList.textContent = '';
    if (loadFailed) {
      draftsList.append(el('div', { fontSize: '12px', opacity: '0.8', padding: '4px 0' },
        loadFailed === 'expired'
          ? 'Editor session expired — reopen it from your dashboard to see your drafts. They’re safe.'
          : 'Couldn’t load your drafts — they’re safe; check your connection and retry.'));
      if (loadFailed === 'error') {
        const retry = smallBtn('#374151', 'Retry');
        retry.onclick = () => void renderDrafts();
        draftsList.append(retry);
      }
      return;
    }
    const testable = rows.filter((r) => (r.draft_config?.arms?.length ?? 0) > 0 || (r.published_config?.arms?.length ?? 0) > 0);
    // The synthetic union rows for SDK-fired goals come back as
    // event='custom' with no display name — they have no definition to
    // preview, track, or discard, so they don't belong in a drafts tray.
    const definedGoals = goals.filter((g) => g.event !== 'custom' && (g.status === 'draft' || g.status === 'active'));
    if (testable.length === 0 && definedGoals.length === 0 && !goalsFailed) {
      draftsList.append(el('div', { fontSize: '12px', opacity: '0.7', padding: '4px 0' },
        'Nothing saved yet — changes and goals you save land here, previewable before they go live.'));
      return;
    }
    const statusChip = (live: boolean): HTMLElement => el('span', {
      fontSize: '10px', padding: '2px 7px', borderRadius: '999px', flex: '0 0 auto',
      background: live ? 'rgba(16,185,129,0.2)' : 'rgba(99,102,241,0.25)',
      color: live ? '#6ee7b7' : '#c7d2fe',
    }, live ? 'live' : 'draft');
    const draftRow = (label: string): { row: HTMLElement; name: HTMLElement } => {
      const row = el('div', {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 0',
        borderBottom: '1px solid rgba(255,255,255,0.08)', fontSize: '12px',
      });
      const name = el('div', { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, label);
      row.append(name);
      return { row, name };
    };
    for (const r of testable) {
      const { row } = draftRow(r.display_name ?? r.slot_id);
      row.append(statusChip(r.status === 'published'));
      const arms = (r.draft_config?.arms ?? r.published_config?.arms ?? []);
      const previewArm = arms[1]?.id ?? arms[0]?.id;
      const prev = smallBtn('#374151', 'Preview');
      prev.onclick = () => gotoPreview(r.slot_id, previewArm);
      row.append(prev);
      if (r.status !== 'published' && (r.draft_config?.arms?.length ?? 0) > 0) {
        const pub = smallBtn('#10b981', 'Publish');
        pub.onclick = async () => {
          pub.disabled = true;
          const r2 = await save(b, `/v1/editor/slots/${encodeURIComponent(r.slot_id)}/publish`, {});
          pub.disabled = false;
          reportSave(r2, '✓ Published — live for new visitors.');
          if (r2.r === 'ok') { emit('published', { kind: 'slot' }); void renderDrafts(); }
        };
        row.append(pub);
      }
      if (r.status !== 'published') {
        // Principle 5: work is previewable, publishable, DISCARDABLE. Server
        // deletes draft-status rows only, so this can never take down live.
        row.append(discardBtn(
          `/v1/editor/slots/${encodeURIComponent(r.slot_id)}`,
          '🗑 Draft discarded — nothing changed for your visitors.',
          () => { dropPendingSlot(r.slot_id); void renderDrafts(); },
        ));
      }
      draftsList.append(row);
    }
    if (goalsFailed) {
      draftsList.append(el('div', { fontSize: '11px', opacity: '0.6', padding: '6px 0 2px' },
        'Couldn’t load your goals right now — they’re safe.'));
    } else if (definedGoals.length > 0) {
      draftsList.append(el('div', { fontSize: '11px', opacity: '0.6', padding: '8px 0 2px' }, 'Goals'));
      for (const g of definedGoals) {
        const { row } = draftRow(g.display_name ?? g.goal_id);
        row.append(statusChip(g.status === 'active'));
        if (g.status === 'draft') {
          const track = smallBtn('#10b981', 'Start tracking');
          track.onclick = async () => {
            track.disabled = true;
            const r2 = await save(b, `/v1/editor/goals/${encodeURIComponent(g.goal_id)}/publish`, {});
            track.disabled = false;
            reportSave(r2, '✓ Tracking is live — it counts from your next visitor.');
            if (r2.r === 'ok') { emit('published', { kind: 'goal' }); void renderDrafts(); }
          };
          row.append(track, discardBtn(
            `/v1/editor/goals/${encodeURIComponent(g.goal_id)}`,
            '🗑 Draft goal discarded — it never tracked anything.',
            () => { dropPendingGoal(g.goal_id); void renderDrafts(); },
          ));
        }
        draftsList.append(row);
      }
    }
  };
  const setActiveTab = (id: TabId): void => {
    // Re-clicking the CURRENT tab must be a no-op: renderActiveTab re-fires
    // the Text/Style auto-open, whose openForm() starts with closeForm() —
    // so without this return a stray click on the active tab wiped an
    // in-progress form and its preview.
    if (activeTab === id) return;
    closeForm(); // switching concerns discards a half-typed form + its preview
    undoMove(); // …and an unsaved move preview: leaving Layout must not leave the page rearranged
    activeTab = id;
    renderActiveTab();
  };

  // Header: brand on the left, pause + close compact on the right.
  const headerRow = el('div', { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' });
  Object.assign(title.style, { marginBottom: '0', flex: '1 1 auto', fontSize: '13px', whiteSpace: 'nowrap' });

  // Collapse to a floating bubble (same idea as the dev-tools launcher): the
  // panel gets out of the way entirely, and collapsing also pauses picking —
  // an invisible editor silently selecting elements would be worse than the
  // old always-open column.
  let pausedBeforeCollapse = false;
  const bubble = el('button', {
    position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483647',
    width: '46px', height: '46px', borderRadius: '50%', border: '1px solid rgba(99,102,241,0.55)',
    background: '#111827', color: '#fff', cursor: 'pointer', display: 'none',
    alignItems: 'center', justifyContent: 'center', gap: '4px',
    font: '700 15px system-ui, sans-serif', boxShadow: '0 10px 34px rgba(0,0,0,0.45)',
  }) as HTMLButtonElement;
  const bubbleDot = el('span', {
    width: '7px', height: '7px', borderRadius: '50%', background: '#34d399', display: 'inline-block',
  });
  bubbleDot.className = 'sntedi-dot';
  bubble.append(bubbleDot, el('span', {}, 'S'));
  bubble.title = 'Open the SentientUI editor';
  const collapseBtn = el('button', {
    display: 'inline-block', width: 'auto', margin: '0', padding: '3px 8px',
    fontSize: '10.5px', borderRadius: '999px', background: '#374151', color: '#fff',
    border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
  }, 'Minimize') as HTMLButtonElement;
  collapseBtn.onclick = () => {
    panel.style.display = 'none';
    bubble.style.display = 'flex';
    pausedBeforeCollapse = pickingPaused;
    pickingPaused = true;
    highlight.style.display = 'none';
    clearTargetHighlights(document);
  };
  bubble.onclick = () => {
    panel.style.display = 'block';
    bubble.style.display = 'none';
    pickingPaused = pausedBeforeCollapse;
  };
  Object.assign(pauseBtn.style, {
    display: 'inline-block', width: 'auto', margin: '0', padding: '3px 8px',
    fontSize: '10.5px', borderRadius: '999px', background: '#374151', whiteSpace: 'nowrap',
  });
  Object.assign(closeBtn.style, {
    display: 'inline-block', width: 'auto', margin: '0', padding: '3px 8px',
    fontSize: '10.5px', borderRadius: '999px', whiteSpace: 'nowrap',
  });
  headerRow.append(title, pauseBtn, collapseBtn, closeBtn);

  // Footer: what just happened + the next action, pinned under every tab.
  // reviewHost holds the post-save review card (spec §2.2): what was created,
  // that nothing is live yet, and Preview/Discard next to the labelled
  // Publish / Start-tracking buttons.
  const footer = el('div', { marginTop: '10px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '8px' });
  const reviewHost = el('div', {});
  Object.assign(status.style, { marginBottom: '4px' });
  footer.append(reviewHost, status, publishBtn, activateGoalBtn);

  const suggestBtn = el('button', {
    display: 'none', width: 'auto', margin: '0', padding: '5px 10px', flex: '0 0 auto',
    fontSize: '11px', borderRadius: '999px', background: 'rgba(250,204,21,0.15)',
    border: '1px solid rgba(250,204,21,0.45)', color: '#fde68a', cursor: 'pointer', whiteSpace: 'nowrap',
  }, '✨ Ask AI') as HTMLButtonElement;
  const selRow = el('div', { display: 'flex', alignItems: 'center', gap: '6px' });
  Object.assign(selectedLabel.style, { flex: '1 1 auto', marginBottom: '0' });
  selRow.append(selectedLabel, suggestBtn);
  Object.assign(selRow.style, { marginBottom: '6px' });
  const aiHost = el('div', {});

  const formHost = el('div', { marginTop: '4px' });
  // Delegated dirty tracking ('input' bubbles): typed fields, AI prefills and
  // swatch picks all mark the form worth protecting from a stray discard.
  formHost.addEventListener('input', () => { formDirty = true; });
  formHost.addEventListener('change', () => { formDirty = true; });
  panel.append(headerRow, hint, selRow, crumbHost, suggestHost, aiHost, tabBar, paneHost, formHost, footer);

  (document.body ?? document.documentElement).append(highlight, selectionRing, panel, bubble);

  // Live-preview bookkeeping: forms apply their candidate change to the real
  // element as the operator types (the move flow already works this way — the
  // style/text forms made people type blind). closeForm DISCARDS the preview;
  // a successful save calls commitPreview first so the approved change stays
  // on screen, mirroring the move flow's "commit the preview" rule.
  let previewRestore: (() => void) | null = null;
  const discardPreview = (): void => { previewRestore?.(); previewRestore = null; };
  const commitPreview = (): void => { previewRestore = null; };
  // Dirty tracking: a form the operator has typed into must not be discarded
  // by ONE stray page click — in picking mode the whole viewport is a click
  // target, so a misclick was the single biggest way to lose work. The first
  // conflicting click warns; a repeat click on the same element confirms.
  let formDirty = false;
  let discardArmed: Element | null = null;
  const closeForm = (): void => { discardPreview(); formHost.textContent = ''; formDirty = false; discardArmed = null; closeArmed = false; };

  // Renders an inline labeled form into the panel (no native prompt, no innerHTML).
  // Field types: 'text' (default), 'color' (<input type=color>, only counts if the
  // user actually touched it, so an untouched picker isn't a stealth black fill),
  // and 'select' (a <select> with a leading "no change" option). onSubmit gets a
  // key→value map plus `fieldError` to flag a specific field's inline feedback.
  type FormField = {
    key: string; label: string; value?: string;
    type?: 'text' | 'color' | 'select'; options?: string[];
  };
  const openForm = (
    fields: FormField[],
    submitLabel: string,
    onSubmit: (
      values: Record<string, string>,
      fieldError: (key: string, msg: string | null) => void,
    ) => void,
  ): void => {
    closeForm();
    const getters: Record<string, () => string> = {};
    const feedbackEls: Record<string, HTMLElement> = {};
    const inputStyle: Partial<CSSStyleDeclaration> = {
      display: 'block', width: '100%', marginTop: '4px', padding: '7px 9px',
      borderRadius: '8px', border: '1px solid rgba(255,255,255,0.18)',
      background: '#1f2937', color: '#fff', font: '13px system-ui, sans-serif',
    };
    for (const f of fields) {
      const label = el('label', { display: 'block', fontSize: '12px', opacity: '0.85', marginTop: '8px' }, f.label);
      formHost.append(label);
      if (f.type === 'select') {
        const select = el('select', inputStyle) as HTMLSelectElement;
        select.setAttribute('data-field', f.key);
        const blank = document.createElement('option');
        blank.value = ''; blank.textContent = '— no change —';
        select.append(blank);
        for (const opt of f.options ?? []) {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          select.append(o);
        }
        getters[f.key] = () => select.value;
        formHost.append(select);
      } else if (f.type === 'color') {
        const input = el('input', { ...inputStyle, padding: '2px', height: '34px' }) as HTMLInputElement;
        input.type = 'color';
        input.setAttribute('data-field', f.key);
        // An <input type=color> always reports a value (defaults to #000000), so
        // only treat it as a change once the user actually interacts with it.
        let touched = false;
        input.addEventListener('input', () => { touched = true; });
        getters[f.key] = () => (touched ? input.value : '');
        formHost.append(input);
      } else {
        const input = el('input', inputStyle) as HTMLInputElement;
        input.setAttribute('data-field', f.key);
        if (f.value !== undefined) input.value = f.value;
        getters[f.key] = () => input.value;
        formHost.append(input);
      }
      const fb = el('div', {
        fontSize: '11px', color: '#fca5a5', marginTop: '3px', display: 'none',
      });
      fb.setAttribute('data-feedback', f.key);
      feedbackEls[f.key] = fb;
      formHost.append(fb);
    }
    const fieldError = (key: string, msg: string | null): void => {
      const fb = feedbackEls[key];
      if (!fb) return;
      fb.textContent = msg ?? '';
      fb.style.display = msg ? 'block' : 'none';
    };
    const submit = el('button', btnStyle('#6366f1'), submitLabel) as HTMLButtonElement;
    const cancel = el('button', { ...btnStyle('transparent'), opacity: '0.6' }, 'Cancel') as HTMLButtonElement;
    submit.onclick = () =>
      onSubmit(Object.fromEntries(Object.entries(getters).map(([k, g]) => [k, g()])), fieldError);
    cancel.onclick = closeForm;
    formHost.append(submit, cancel);
  };

  const setStatus = (text: string, ok = true): void => {
    status.textContent = text;
    status.style.color = ok ? '#a7f3d0' : '#fca5a5';
  };

  // Human copy for a failed outcome, mapped from the server's machine codes.
  // A plan limit is an upgrade prompt, not an apology; a role gate names who
  // can fix it; anything unmapped keeps its HTTP status in the line so a
  // support screenshot carries the cause instead of only "try again".
  const failureText = (o: SaveOutcome, verb: string): string => {
    emit('error_shown', { code: o.code ?? `http_${o.status ?? 'network'}` });
    if (o.code === 'plan_limit_reached') {
      const noun = o.feature === 'live_goals' ? 'live goal' : 'of these';
      const planName = o.plan ? `${o.plan} plan` : 'plan';
      return o.feature === 'live_goals'
        ? `Your ${planName} includes 1 live goal. Pause another goal in your dashboard, or upgrade to track more.`
        : `Your ${planName} has reached its limit for ${noun}. Manage them in your dashboard, or upgrade for more.`;
    }
    if (o.code === 'role_required') return 'Your account can view but not edit this project — ask an admin for editor access.';
    // demo_read_only (and friends) already ship a human sentence server-side.
    if (o.code === 'demo_read_only' && o.message) return o.message;
    const status = o.status ? ` (HTTP ${o.status})` : '';
    return `⚠ Couldn’t ${verb} — try again.${status}`;
  };

  // Map a save outcome to a status line. 'expired' gets its own message so the
  // user knows a retry won't help (the token is dead) and that reopening the
  // editor is how to recover — their already-saved drafts are untouched.
  const reportSave = (o: SaveOutcome, okMsg: string): void => {
    if (o.r === 'ok') setStatus(okMsg, true);
    else if (o.r === 'expired') setStatus('Editor session expired — reopen it from your dashboard to save this. Your earlier changes are safe.', false);
    else setStatus(failureText(o, 'save'), false);
  };

  // After a slot draft saves, reveal "Publish now" targeting that slot. Publishing
  // is bounded/validated server-side (validateDraftConfig) and versioned, so it's
  // reversible from the dashboard. The funnel-attach action targets the same
  // slot — "this test serves step N of Checkout".
  let pendingPublishSlotId: string | null = null;
  // The button NAMES its target: pendingPublishSlotId survives selecting a
  // different element (deliberately — the golden path stays one click away),
  // so an unlabelled "Publish now" next to a new selection read as "publish
  // what I just clicked" and published the previous element's draft.
  const shortLabel = (s: string): string => (s.length > 30 ? `${s.slice(0, 27)}…` : s);

  // Retire the pending slot/goal state a review card fronts — after publish,
  // activate, or discard (including a discard from the Drafts tab).
  const dropPendingSlot = (slotId: string): void => {
    if (pendingPublishSlotId !== slotId) return;
    pendingPublishSlotId = null;
    publishBtn.style.display = 'none';
    attachFunnelBtn.style.display = 'none';
    reviewHost.textContent = '';
  };
  const dropPendingGoal = (goalId: string): void => {
    if (pendingGoalId !== goalId) return;
    pendingGoalId = null;
    activateGoalBtn.style.display = 'none';
    reviewHost.textContent = '';
  };

  const offerPublish = (slotId: string, label?: string, previewArm?: string): void => {
    pendingPublishSlotId = slotId;
    publishBtn.textContent = label ? `Publish “${shortLabel(label)}” — go live` : 'Publish now — go live';
    publishBtn.style.display = 'block';
    attachFunnelBtn.style.display = 'block';
    // The review card makes preview discoverable from inside the editor —
    // it was a Drafts-tab-only find before.
    const verbs: HTMLElement[] = [];
    if (previewArm) {
      const prev = smallBtn('#374151', 'Preview');
      prev.onclick = () => gotoPreview(slotId, previewArm);
      verbs.push(prev);
    }
    verbs.push(discardBtn(
      `/v1/editor/slots/${encodeURIComponent(slotId)}`,
      '🗑 Draft discarded — nothing changed for your visitors.',
      () => dropPendingSlot(slotId),
    ));
    renderReviewCard(
      label ? `Draft saved for “${shortLabel(label)}” — nothing is live for visitors yet.`
            : 'Draft saved — nothing is live for visitors yet.',
      verbs,
    );
  };
  publishBtn.onclick = async () => {
    if (!pendingPublishSlotId) return;
    publishBtn.disabled = true;
    setStatus('Publishing…');
    const r = await save(b, `/v1/editor/slots/${encodeURIComponent(pendingPublishSlotId)}/publish`, {});
    publishBtn.disabled = false;
    if (r.r === 'ok') {
      emit('published', { kind: 'slot' });
      setStatus('✓ Published — live for new visitors.', true);
      publishBtn.style.display = 'none';
      pendingPublishSlotId = null;
      reviewHost.textContent = ''; // the card's draft is now live
    } else if (r.r === 'expired') {
      setStatus('Editor session expired — reopen it from your dashboard to publish. Your saved draft is safe.', false);
    } else {
      setStatus(failureText(r, 'publish'), false);
    }
  };

  let currentLocator: CompoundLocator | null = null;
  let selectedUnique = false;
  let prevEl: Element | null = null;
  let nextEl: Element | null = null;
  let prevLocator: CompoundLocator | null = null;
  let nextLocator: CompoundLocator | null = null;
  // The element's original position, captured once at the first move so Undo can
  // restore it and repeated moves don't lose the true starting point.
  let moveOrigParent: Element | null = null;
  let moveOrigNext: Node | null = null;
  let moved = false;

  // The move buttons enable purely on whether a resolvable neighbor exists in the
  // element's CURRENT position — NOT force-disabled during a preview, so a user
  // can chain several moves before saving. Disabled directions carry a tooltip
  // saying WHY instead of silently greying out.
  const moveDisabledReason = (neighborLocator: CompoundLocator | null, edge: string): string => {
    if (!selectedUnique) return 'This element can’t be targeted reliably, so it can’t be moved.';
    if (!neighborLocator) return `Nothing to swap with ${edge} — it’s at the edge, or that neighbor can’t be targeted reliably.`;
    return '';
  };
  const refreshMoveButtons = (): void => {
    moveUpBtn.disabled = !selectedUnique || !prevLocator;
    moveDownBtn.disabled = !selectedUnique || !nextLocator;
    moveUpBtn.title = moveUpBtn.disabled ? moveDisabledReason(prevLocator, 'above') : '';
    moveDownBtn.title = moveDownBtn.disabled ? moveDisabledReason(nextLocator, 'below') : '';
  };
  const showMovePreviewControls = (show: boolean): void => {
    saveArrangeBtn.style.display = show ? 'block' : 'none';
    undoBtn.style.display = show ? 'block' : 'none';
    refreshMoveButtons();
  };

  /** Restore the selected element to its original (pre-move) position, if any
   *  moves are pending. Safe to call when there is nothing to undo. */
  const undoMove = (): void => {
    if (moved && selected && moveOrigParent) {
      moveOrigParent.insertBefore(selected, moveOrigNext);
    }
    moved = false; moveOrigParent = null; moveOrigNext = null;
    if (selected) {
      const a = computeMoveAnchors(selected, document);
      prevEl = a.prevEl; nextEl = a.nextEl; prevLocator = a.prevLocator; nextLocator = a.nextLocator;
    }
    positionSelectionRing();
    showMovePreviewControls(false);
  };

  const onMove = (e: MouseEvent): void => {
    if (pickingPaused) return;
    const t = e.target as Element | null;
    if (!t || panel.contains(t) || t === highlight) return;
    clearTargetHighlights(document); // user is picking their own element now
    const r = t.getBoundingClientRect();
    Object.assign(highlight.style, {
      display: 'block', left: `${r.left}px`, top: `${r.top}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
  };

  /** Short human handle for the selected element ("Request a demo" / "image"). */
  const describeElement = (t: Element): string => {
    const text = (t.textContent ?? '').trim().replace(/\s+/g, ' ');
    if (text) return text.length > 40 ? `${text.slice(0, 37)}…` : text;
    return t.tagName.toLowerCase();
  };

  /** Ancestors worth showing as crumbs: things a person would call "a part of
   *  the page" (id, landmark tag, heading inside), not anonymous wrappers —
   *  a chain of unnamed divs would bury the one useful hop. */
  const crumbWorthy = (a: Element): boolean =>
    !!a.id ||
    ['section', 'header', 'footer', 'nav', 'main', 'form', 'article', 'aside'].includes(a.tagName.toLowerCase()) ||
    !!a.querySelector(':scope > h1, :scope > h2, :scope > h3');

  /** Crumb label for a CONTAINER: its own heading beats concatenated inner
   *  text ("MetalsFerrous and non-ferrous…" told nobody anything), then id,
   *  then tag. Kept short — a crumb is a handle, not a description. */
  const crumbLabel = (a: Element): string => {
    const h = a.querySelector('h1, h2, h3');
    const ht = h?.textContent?.replace(/\s+/g, ' ').trim();
    if (ht) return ht.length > 28 ? `${ht.slice(0, 25)}…` : ht;
    if (a.id) return `#${a.id.length > 24 ? `${a.id.slice(0, 21)}…` : a.id}`;
    return `<${a.tagName.toLowerCase()}>`;
  };

  const renderCrumbs = (t: Element): void => {
    crumbHost.textContent = '';
    const chain: Element[] = [];
    for (let a = t.parentElement; a && a !== document.body && chain.length < 3; a = a.parentElement) {
      if (crumbWorthy(a)) chain.push(a);
    }
    const selfLabel = describeElement(t);
    const sep = (): HTMLElement => el('span', { opacity: '0.5', margin: '0 4px' }, '‹');
    let first = true;
    for (const a of chain) {
      const label = crumbLabel(a);
      // A heading's parent section carries the same words as the heading —
      // repeating them as a crumb reads like a stutter, not a level.
      if (label === selfLabel || selfLabel.startsWith(label)) continue;
      const link = el('button', {
        background: 'transparent', border: 'none', color: '#a5b4fc', cursor: 'pointer',
        font: 'inherit', padding: '0', textDecoration: 'underline',
      }, label) as HTMLButtonElement;
      link.onclick = () => selectElement(a);
      if (!first) crumbHost.append(sep());
      crumbHost.append(link);
      first = false;
    }
    if (!first) crumbHost.append(sep());
    // "Page" DESELECTS (spec phase 1 task 4): it is the root of the crumb
    // trail, so clicking it returns to the pre-selection state — the only
    // other exits were selecting something else or closing the editor.
    const pageLink = el('button', {
      background: 'transparent', border: 'none', color: '#a5b4fc', cursor: 'pointer',
      font: 'inherit', padding: '0', textDecoration: 'underline', opacity: '0.7',
    }, 'Page') as HTMLButtonElement;
    pageLink.onclick = () => deselect();
    crumbHost.append(pageLink);
    crumbHost.style.display = 'block';
  };

  /** Recovery card for a non-unique selection. "Couldn't target this element
   *  uniquely" was a dead end — a novice has nothing to do next. Offer the
   *  nearest ancestor that CAN be targeted as a one-click reselect instead. */
  const renderSuggestion = (t: Element): void => {
    suggestHost.textContent = '';
    let ancestor: Element | null = null;
    let hops = 0;
    for (let a = t.parentElement; a && a !== document.body && hops < 6; a = a.parentElement, hops++) {
      if (resolvesUniquely(generateLocator(a, document), a, document)) { ancestor = a; break; }
    }
    const card = el('div', {
      marginBottom: '8px', padding: '8px 10px', borderRadius: '8px', fontSize: '12px',
      background: 'rgba(252,165,165,0.12)', border: '1px solid rgba(252,165,165,0.4)',
    });
    if (ancestor) {
      const anc = ancestor;
      card.append(el('div', { marginBottom: '6px' },
        'This exact element can’t be tracked safely — it looks identical to others on the page. You can pick something more specific inside it, or work with the whole block, which we can target reliably.'));
      const pick = el('button', { ...btnStyle('#6366f1'), marginTop: '0' },
        `Select “${describeElement(anc)}” instead`) as HTMLButtonElement;
      pick.onclick = () => selectElement(anc);
      const dismiss = el('button', { ...btnStyle('transparent'), opacity: '0.6' }, 'Pick something else') as HTMLButtonElement;
      dismiss.onclick = () => { suggestHost.textContent = ''; };
      card.append(pick, dismiss);
    } else {
      card.append(el('div', {},
        'This part of the page can’t be targeted reliably — try a heading, a button, or a whole section instead.'));
    }
    suggestHost.append(card);
  };

  const selectElement = (t: Element): void => {
    undoMove(); // selecting a new element abandons any unsaved move preview
    closeForm(); // and any half-filled form for the previous element
    suggestHost.textContent = '';

    selected = t;
    currentLocator = generateLocator(t, document);
    const unique = resolvesUniquely(currentLocator, t, document);
    selectedUnique = unique;
    positionSelectionRing();
    selectedLabel.style.display = 'block';
    selectedLabel.textContent = `Selected: ${describeElement(t)}`;
    renderCrumbs(t);
    emit('element_selected', { unique });
    setStatus(unique ? '✓ Matches exactly 1 element' : '', unique);
    if (!unique) renderSuggestion(t);
    hint.style.display = 'none';
    suggestBtn.style.display = 'inline-block';
    aiHost.textContent = ''; // stale suggestions describe the previous element
    // Reveal the element actions now there is something for them to act on.
    for (const btn of elementButtons) btn.style.display = 'block';
    // Text/Style are headless triggers now — their TAB opens the form
    // directly, so the buttons themselves never render.
    textBtn.style.display = 'none';
    styleBtn.style.display = 'none';
    // The text test applies via el.textContent (ops.ts), which REPLACES all child
    // markup — arming "Original" on a container like <h1>Get <span>started</span></h1>
    // would flatten it to plain text for every visitor. So the text test is offered
    // only for leaf / text-only elements; containers get a disabled button that
    // explains why. Style and goal are non-destructive and stay gated on uniqueness
    // alone.
    const isLeaf = t.childElementCount === 0;
    (textBtn as HTMLButtonElement).disabled = !unique || !isLeaf;
    textBtn.title = !unique ? ''
      : isLeaf ? ''
      : 'This element contains other elements, so testing text here would replace them. Pick the text itself (e.g. the heading), not its container.';
    (styleBtn as HTMLButtonElement).disabled = !unique;
    (arrangeBtn as HTMLButtonElement).disabled = !unique;
    (goalBtn as HTMLButtonElement).disabled = !unique;
    // Form tracking only makes sense when the click landed inside a form.
    const form = t.closest('form');
    formGoalBtn.style.display = form ? 'block' : 'none';
    formGoalBtn.disabled = !form;

    const anchors = computeMoveAnchors(t, document);
    prevEl = anchors.prevEl; nextEl = anchors.nextEl;
    prevLocator = anchors.prevLocator; nextLocator = anchors.nextLocator;
    // Both the selected element AND the sibling anchor must resolve uniquely —
    // a unique sibling next to a non-targetable element would still save a
    // draft whose target never resolves (a silent no-op).
    refreshMoveButtons();
    // New selection re-renders the active tab (Text/Style auto-open for it).
    renderActiveTab();
  };

  /** Back to the pre-selection state: no element, hint visible, element
   *  actions hidden. Reached from the "Page" crumb and from Escape. */
  const deselect = (): void => {
    undoMove(); // undoMove reads `selected` — run it before clearing
    closeForm();
    selected = null;
    currentLocator = null;
    selectedUnique = false;
    prevEl = null; nextEl = null; prevLocator = null; nextLocator = null;
    positionSelectionRing(); // hides the ring (nothing is selected)
    suggestHost.textContent = '';
    aiHost.textContent = '';
    crumbHost.textContent = '';
    crumbHost.style.display = 'none';
    selectedLabel.textContent = '';
    selectedLabel.style.display = 'none';
    suggestBtn.style.display = 'none';
    for (const btn of elementButtons) btn.style.display = 'none';
    hint.style.display = 'block';
    setStatus('');
    renderActiveTab();
  };

  // Keyboard (spec phase 3):
  // - Escape backs out one layer at a time: open form (same as Cancel) →
  //   selection → an ARMED close ("Esc again"), so a single reflexive Esc can
  //   never throw the session away.
  // - Arrow Up/Down move the selected element — exactly the Move buttons'
  //   guards, so a disabled direction stays disabled here too.
  // - Tab / Shift+Tab cycle the audit-detected targets that resolve on this
  //   page — the one keyboard route into element picking. With no targets Tab
  //   keeps its normal focus behavior (never hijack a key for nothing).
  let escCloseArmed = false;
  let targetCycleIdx = -1;
  const onKeyDown = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    const inField = !!t?.closest?.('input, textarea, select, [contenteditable="true"]');
    if (e.key === 'Escape') {
      if (formHost.childElementCount > 0) { closeForm(); escCloseArmed = false; return; }
      if (selected) { deselect(); escCloseArmed = false; return; }
      if (!escCloseArmed) {
        escCloseArmed = true;
        setStatus('Press Esc again to close the editor.');
        return;
      }
      escCloseArmed = false;
      closeBtn.onclick?.(new MouseEvent('click') as never); // same unsaved-work guard as the button
      return;
    }
    escCloseArmed = false;
    if (inField || pickingPaused) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!selected) return;
      const btn = e.key === 'ArrowUp' ? moveUpBtn : moveDownBtn;
      if (btn.disabled) return; // silent like a disabled button; its tooltip carries the reason
      e.preventDefault(); // the move already scrolls the element into view — don't also scroll the page
      doMove(e.key === 'ArrowUp' ? 'up' : 'down');
      return;
    }
    if (e.key === 'Tab') {
      const resolved: Element[] = [];
      for (const target of keyboardTargets) {
        const node = resolveLocatorOne(target.locator, document);
        if (node && !resolved.includes(node)) resolved.push(node);
      }
      if (resolved.length === 0) return;
      if (formDirty) {
        setStatus('⚠ You have unsaved changes — Save or Cancel before picking another element.', false);
        e.preventDefault();
        return;
      }
      e.preventDefault();
      targetCycleIdx = (targetCycleIdx + (e.shiftKey ? -1 : 1) + resolved.length) % resolved.length;
      const next = resolved[targetCycleIdx]!;
      selectElement(next);
      try { next.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* older browsers */ }
    }
  };

  const onClick = (e: MouseEvent): void => {
    if (pickingPaused) return;
    const t = e.target as Element | null;
    if (!t || panel.contains(t)) return;
    e.preventDefault();
    e.stopPropagation();
    // A half-typed form + its preview would be destroyed by this selection —
    // warn once; clicking the same element again (or Save/Cancel) proceeds.
    if (formDirty && t !== selected && discardArmed !== t) {
      discardArmed = t;
      setStatus('⚠ You have unsaved changes — Save or Cancel first, or click that element again to discard them.', false);
      return;
    }
    selectElement(t);
  };

  textBtn.onclick = () => {
    if (!selected || !currentLocator) return;
    emit('form_opened', { kind: 'text' });
    const loc = currentLocator;
    const original = selected.textContent?.trim() ?? '';
    openForm(
      [
        { key: 'current', label: 'Current wording', value: original },
        { key: 'alt', label: 'Alternative wording to test', value: '' },
      ],
      'Save draft',
      async (v) => {
        // Guard an empty (or unchanged) alternative: ops.text applies via
        // el.textContent, so saving arm b with '' would blank the element for
        // every visitor bucketed to it. Validate before saving (mirrors the
        // style flow's "enter at least one change" guard).
        const alt = v.alt.trim();
        if (!alt) { setStatus('⚠ Enter alternative wording to test.', false); return; }
        if (alt === v.current.trim()) { setStatus('⚠ Enter different wording — the alternative matches the current text.', false); return; }
        const slotId = deriveSlotId('text', loc, selected!);
        setStatus('Saving…');
        const r = await save(b, `/v1/editor/slots/${encodeURIComponent(slotId)}`, {
          kind: 'arms',
          target: loc,
          draftConfig: { arms: [
            { id: 'a', displayName: 'Original', ops: { text: v.current } },
            { id: 'b', displayName: 'Alternative', ops: { text: v.alt } },
          ] },
        });
        if (r.r === 'ok') { emit('draft_saved', { kind: 'slot' }); commitPreview(); closeForm(); offerPublish(slotId, describeElement(selected!), 'b'); }
        reportSave(r, '✓ Saved as a draft. Click “Publish” below to go live.');
      },
    );

    // Live preview: the alternative wording lands on the element as it is
    // typed (leaf-only, same guard as the form itself); empty restores the
    // original so backspacing never leaves a blank element on screen.
    const target = selected;
    const origText = target.textContent ?? '';
    previewRestore = () => { target.textContent = origText; };
    const altField = formHost.querySelector<HTMLInputElement>('input[data-field="alt"]');
    altField?.addEventListener('input', () => {
      target.textContent = altField.value.trim() === '' ? origText : altField.value;
    });
  };

  // Arrangement picker (Track B B3): list the catalog, fill an arrangement's
  // fields, and save a composition draft that tests it against the section as
  // it is today ('original' arm with no blocks = the control). The server does
  // all validation — instantiate total-validates the tree, and the slot save
  // re-validates via validateDraftConfig — so this flow is only forms.
  type EditorArrangement = {
    id: string; sectionType: string; name: string; description: string;
    fields: Array<{ id: string; label: string; kind: 'text' | 'href'; default?: string }>;
  };
  let arrangementsCache: EditorArrangement[] | null = null;

  // Existing copy harvested from the selected section. This is what makes an
  // arrangement a RE-LAYOUT of what the page already says rather than a new
  // section: it both prefills the form and, via sectionTypesFor, decides which
  // layouts are offered at all. The catalog's own `default` values are designer
  // lorem and are never used here.
  const harvestCopy = (target: Element): SectionCopy => {
    const txt = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const headings = Array.from(target.querySelectorAll('h1,h2,h3,h4')).map(txt).filter(Boolean);
    if (headings.length === 0) {
      // The operator may have selected the heading itself rather than the section.
      const self = target.closest('h1,h2,h3,h4');
      if (self) headings.push(txt(self));
    }
    const paragraphs = Array.from(target.querySelectorAll('p')).map(txt).filter((t) => t.length > 0 && t.length <= 300);
    const links: Array<{ label: string; href: string }> = [];
    for (const el of Array.from(target.querySelectorAll('a[href], button'))) {
      const label = txt(el);
      if (!label || label.length > 60) continue;
      // https only — the server's block validation rejects anything else, so a
      // relative/insecure href must stay empty rather than prefill a save error.
      let href = '';
      const raw = el.getAttribute('href');
      if (raw) {
        try {
          const u = new URL(raw, window.location.href);
          if (u.protocol === 'https:') href = u.href;
        } catch { /* not a URL — leave empty */ }
      }
      links.push({ label, href });
    }
    // Quotes drive the testimonial gate, so look past <blockquote>: plenty of
    // real testimonial sections are <div class="testimonial"> with a <p> in it,
    // and missing them would refuse to re-lay-out a section that plainly IS
    // testimonials.
    const quotes = Array.from(target.querySelectorAll('blockquote, q')).map(txt).filter(Boolean);
    if (quotes.length === 0 && TESTIMONIAL_HINT.test(`${target.className} ${target.id}`)) {
      for (const p of paragraphs) if (p.length >= 20) quotes.push(p);
    }
    // Attribution lines ("Alex P.", "Founder, Example Co.") so a re-layout keeps
    // the site's real names instead of asking for them again.
    const attributions = Array.from(target.querySelectorAll('cite, figcaption, footer, [class*="author"]'))
      .map(txt)
      .filter((t) => t.length > 0 && t.length <= 80);
    return { headings, paragraphs, links, quotes, attributions };
  };

  const prefillFor = (fieldId: string, c: SectionCopy): string => {
    // f*_body: the LAST three paragraphs — a features section often opens with
    // an intro paragraph, and the card bodies come after it.
    const tail = (n: number): string => (c.paragraphs.length >= 3 ? c.paragraphs[c.paragraphs.length - 3 + n] ?? '' : '');
    switch (fieldId) {
      case 'headline': return c.headings[0] ?? '';
      case 'supporting': return c.paragraphs[0] ?? '';
      case 'cta_label': return c.links[0]?.label ?? '';
      case 'cta_href': return c.links[0]?.href ?? '';
      case 'secondary_label': return c.links[1]?.label ?? '';
      case 'secondary_href': return c.links[1]?.href ?? '';
      case 'quote': case 'q1': return c.quotes[0] ?? '';
      case 'q2': return c.quotes[1] ?? '';
      case 'q3': return c.quotes[2] ?? '';
      case 'name': case 'n1': return c.attributions[0] ?? '';
      case 'n2': return c.attributions[1] ?? '';
      case 'n3': return c.attributions[2] ?? '';
      case 'role': return c.attributions[1] ?? '';
      case 'eyebrow': return '';
      case 'f1_title': return c.headings[1] ?? '';
      case 'f2_title': return c.headings[2] ?? '';
      case 'f3_title': return c.headings[3] ?? '';
      case 'f1_body': return tail(0);
      case 'f2_body': return tail(1);
      case 'f3_body': return tail(2);
      default: return '';
    }
  };

  const openArrangementFields = (a: EditorArrangement, loc: CompoundLocator, target: Element): void => {
    emit('form_opened', { kind: 'arrangement' });
    const copy = harvestCopy(target);
    openForm(
      // Prefilled from the SECTION ONLY — never from the catalog's own
      // `default`. Those defaults are designer lorem ("Alex P., Founder,
      // Example Co."), and the server substitutes them for any field left
      // blank, so seeding them here meant one un-edited field was enough to
      // publish invented copy in the merchant's brand voice.
      a.fields.map((f) => ({
        key: f.id,
        label: f.kind === 'href' ? `${f.label} (https link — required)` : f.label,
        value: prefillFor(f.id, copy),
      })),
      'Save draft',
      async (v, fieldError) => {
        // Validate https links BEFORE the round-trip: the server rejects any
        // other scheme (composition-blocks checkUrl), and learning that only
        // after submit made the failure read as "check the fields" with no
        // field named. The label already promises "https link — required";
        // enforcement must match it, inline.
        let badLink = false;
        let blank = false;
        for (const f of a.fields) {
          if (f.kind === 'href') {
            let ok = false;
            try { ok = new URL(v[f.id] ?? '').protocol === 'https:'; } catch { /* not a URL */ }
            fieldError(f.id, ok ? null : 'Links need to start with https://');
            if (!ok) badLink = true;
            continue;
          }
          // Every text field is required for the same reason the defaults are
          // gone: the server fills a blank with catalog lorem, so an empty box
          // is not "leave it out", it is "publish someone else's words".
          const empty = (v[f.id] ?? '').trim() === '';
          fieldError(f.id, empty ? 'Fill this in with your own words' : null);
          if (empty) blank = true;
        }
        if (badLink) { setStatus('⚠ Fix the highlighted link(s).', false); return; }
        if (blank) { setStatus('⚠ Every field needs your own words — this layout re-arranges your copy, it doesn’t write any.', false); return; }
        setStatus('Saving…');
        const inst = await saveJson<{ blocks?: unknown; reason?: string }>(
          b, `/v1/editor/arrangements/${encodeURIComponent(a.id)}/instantiate`, { fields: v },
        );
        if (inst.r !== 'ok' || !inst.data?.blocks) {
          if (inst.r === 'expired') reportSave(inst.outcome, '');
          else setStatus(`⚠ ${inst.data?.reason ?? 'Couldn’t build the arrangement — check the fields.'}`, false);
          return;
        }
        const slotId = deriveSlotId('arrange', loc, target);
        const r = await save(b, `/v1/editor/slots/${encodeURIComponent(slotId)}`, {
          kind: 'arms',
          target: loc,
          draftConfig: {
            arms: [
              { id: 'original', displayName: 'Your page today' },
              { id: a.id, displayName: a.name, blocks: inst.data.blocks },
            ],
            baseline: 'original',
          },
        });
        if (r.r === 'ok') { emit('draft_saved', { kind: 'arrangement' }); closeForm(); offerPublish(slotId, a.name, a.id); }
        reportSave(r, '✓ Saved as a draft — it will test against this section as it is today. Click “Publish” below to go live.');
      },
    );
  };

  arrangeBtn.onclick = async () => {
    if (!selected || !currentLocator) return;
    const loc = currentLocator;
    const target = selected;
    closeForm();
    setStatus('Loading arrangements…');
    if (!arrangementsCache) {
      const body = await fetchEditorJson<{ arrangements: EditorArrangement[] }>(b, '/v1/editor/arrangements');
      arrangementsCache = body?.arrangements ?? null;
    }
    if (!arrangementsCache || arrangementsCache.length === 0) {
      setStatus('⚠ Couldn’t load the arrangements — try again.', false);
      return;
    }
    // Only layouts for what this section ALREADY contains. Without this gate
    // the picker offered all eight regardless of the selection, so a section
    // with no testimonials could be "re-arranged" into a testimonial block that
    // the catalog then filled with its own placeholder quotes.
    const allowed = sectionTypesFor(harvestCopy(target));
    const fitting = arrangementsCache.filter((a) => allowed.includes(a.sectionType));
    if (fitting.length === 0) {
      setStatus(
        'No other layout fits this section. Layouts re-arrange the words already here — they don’t add sections your page doesn’t have.',
        false,
      );
      return;
    }
    setStatus('Pick a layout for this section — your own words are carried across.');
    for (const a of fitting) {
      const pick = el('button', { ...btnStyle('#374151'), textAlign: 'left' }) as HTMLButtonElement;
      pick.append(
        el('div', { fontWeight: '600' }, a.name),
        el('div', { fontSize: '11px', opacity: '0.7' }, a.description),
      );
      pick.onclick = () => openArrangementFields(a, loc, target);
      formHost.append(pick);
    }
    const cancel = el('button', { ...btnStyle('transparent'), opacity: '0.6' }, 'Cancel') as HTMLButtonElement;
    cancel.onclick = closeForm;
    formHost.append(cancel);
    // The list can exceed the panel's max-height; bring its top into the
    // panel's scroll view so the choices are visible without hunting.
    // (optional-called: jsdom has no scrollIntoView.)
    formHost.scrollIntoView?.({ block: 'nearest' });
  };

  // After a goal draft saves, reveal "Start tracking now" — mirrors the slot
  // save → publish shape so the whole loop finishes without the dashboard.
  let pendingGoalId: string | null = null;
  // Named for the same reason as offerPublish: the pending goal survives a new
  // selection, so the button must say WHICH goal it starts tracking.
  const offerGoalActivation = (goalId: string, label?: string): void => {
    pendingGoalId = goalId;
    activateGoalBtn.textContent = label ? `Start tracking “${shortLabel(label)}” now` : 'Start tracking now';
    activateGoalBtn.style.display = 'block';
    renderReviewCard(
      label ? `Goal “${shortLabel(label)}” saved — it isn’t counting anything until you start it.`
            : 'Goal saved — it isn’t counting anything until you start it.',
      [discardBtn(
        `/v1/editor/goals/${encodeURIComponent(goalId)}`,
        '🗑 Draft goal discarded — it never tracked anything.',
        () => dropPendingGoal(goalId),
      )],
    );
  };
  activateGoalBtn.onclick = async () => {
    if (!pendingGoalId) return;
    activateGoalBtn.disabled = true;
    setStatus('Activating…');
    const r = await save(b, `/v1/editor/goals/${encodeURIComponent(pendingGoalId)}/publish`, {});
    activateGoalBtn.disabled = false;
    if (r.r === 'ok') {
      emit('published', { kind: 'goal' });
      setStatus('✓ Tracking is live — it counts from your next visitor.', true);
      activateGoalBtn.style.display = 'none';
      pendingGoalId = null;
      reviewHost.textContent = ''; // the card's goal is now tracking
    } else if (r.r === 'expired') {
      setStatus('Editor session expired — reopen it from your dashboard to activate. Your saved goal is safe.', false);
    } else {
      setStatus(failureText(r, 'activate'), false);
    }
  };

  // One-click goal tracking: no name field. The goal id is derived (readable
  // slug + a stable locator/path hash so same-text elements never collide, and
  // re-tracking the same element updates the same draft), and the dashboard
  // shows a server-derived business-language name ("Clicks on 'Get started'")
  // — the id is plumbing the user never has to see or invent.
  const deriveGoalId = (seed: string, uniquenessKey: string): string => {
    const slug = slugify(seed) || 'goal';
    return `${slug}-${hash36(uniquenessKey)}`.slice(0, 128);
  };
  /**
   * Seed for a click goal's id. Same precedence as the server's display-name
   * derivation (deriveGoalDisplayName in apps/api/src/domain/goal-definitions.ts)
   * so the id and the name describe the element the same way: the visible label
   * first, then a human-authored aria-label, then the DOM id — which is usually
   * plumbing ('cta', 'btn-1') and only worth using when nothing better exists.
   *
   * The length gate mirrors the server's: textContent is every descendant glued
   * together, so a whole product card would otherwise slugify to
   * `add-to-cartfrom-29-00-sold-outsubscribe-`. Whitespace is collapsed first
   * because textContent carries the source's newlines and indentation.
   *
   * The id is mostly plumbing, but not entirely: it is the display fallback
   * when no name can be derived, and it is what an agent is told to paste into
   * client.goal('<goalId>'). Note this changes the seed for elements whose text
   * was long — re-tracking such an element after this ships mints a new draft
   * beside the old one instead of updating it. That only affects elements whose
   * old id was soup anyway.
   */
  const goalSeed = (t: Element): string => {
    const text = (t.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text && text.length <= 60) return text;
    const named = (t.getAttribute('aria-label') ?? t.getAttribute('id') ?? '').trim();
    return named || 'element-clicked';
  };
  const saveGoal = async (
    goalId: string,
    payload: {
      event: 'click' | 'form_submit' | 'url_reached' | 'scroll_depth';
      locator?: CompoundLocator; urlPattern?: string; threshold?: number;
    },
    label?: string,
  ): Promise<void> => {
    setStatus('Saving…');
    const r = await save(b, `/v1/editor/goals/${encodeURIComponent(goalId)}`, payload);
    if (r.r === 'ok') { emit('draft_saved', { kind: 'goal' }); offerGoalActivation(goalId, label); }
    reportSave(r, '✓ Goal saved. Click “Start tracking” below to go live.');
  };

  goalBtn.onclick = () => {
    if (!selected || !currentLocator) return;
    const goalId = deriveGoalId(goalSeed(selected), JSON.stringify(currentLocator));
    void saveGoal(goalId, { event: 'click', locator: currentLocator }, describeElement(selected));
  };

  formGoalBtn.onclick = () => {
    const form = selected?.closest('form');
    if (!form) return;
    const formLoc = generateLocator(form, document);
    const seed = form.getAttribute('id') ?? form.getAttribute('name') ?? 'form-submitted';
    void saveGoal(deriveGoalId(seed, JSON.stringify(formLoc)), { event: 'form_submit', locator: formLoc }, seed);
  };

  pageGoalBtn.onclick = () => {
    const path = window.location.pathname || '/';
    const seed = slugify(path) ? `reached-${slugify(path)}` : 'page-visited';
    void saveGoal(deriveGoalId(seed, path), { event: 'url_reached', urlPattern: path }, path);
  };

  const SCROLL_CHOICES: Array<{ label: string; value: number }> = [
    { label: '25% — skimmed the top', value: 0.25 },
    { label: '50% — read halfway', value: 0.5 },
    { label: '75% — read most of the page', value: 0.75 },
    { label: '90% — read to the end', value: 0.9 },
  ];
  scrollGoalBtn.onclick = () => {
    openForm(
      [{ key: 'depth', label: 'Counts once a visitor reads', type: 'select', options: SCROLL_CHOICES.map((c) => c.label) }],
      'Track it',
      (v) => {
        const choice = SCROLL_CHOICES.find((c) => c.label === v.depth) ?? SCROLL_CHOICES[2]!;
        const pct = Math.round(choice.value * 100);
        // Depth goals are page-agnostic: the same threshold on any page is the
        // same goal, so the id is stable and re-tracking updates the draft.
        void saveGoal(`read-${pct}pct`, { event: 'scroll_depth', threshold: choice.value }, `read ${pct}%`);
        closeForm();
      },
    );
  };

  // ---- Funnels: pick tracked goals in order → draft funnel → turn on; attach
  // the just-saved slot to a step. Click order IS the funnel order. ----------
  let pendingFunnelId: string | null = null;
  const offerFunnelPublish = (funnelId: string): void => {
    pendingFunnelId = funnelId;
    publishFunnelBtn.style.display = 'block';
  };
  publishFunnelBtn.onclick = async () => {
    if (!pendingFunnelId) return;
    publishFunnelBtn.disabled = true;
    setStatus('Turning on…');
    const r = await save(b, `/v1/editor/funnels/${encodeURIComponent(pendingFunnelId)}/publish`, {});
    publishFunnelBtn.disabled = false;
    if (r.r === 'ok') {
      emit('published', { kind: 'funnel' });
      setStatus('✓ Funnel is on — the drop-off view fills in as visitors move through it.', true);
      publishFunnelBtn.style.display = 'none';
      pendingFunnelId = null;
    } else if (r.r === 'expired') {
      setStatus('Editor session expired — reopen it from your dashboard to turn the funnel on. Your draft is safe.', false);
    } else {
      setStatus('⚠ Couldn’t turn the funnel on — try again.', false);
    }
  };

  funnelBtn.onclick = async () => {
    setStatus('Loading your goals…');
    const body = await fetchEditorJson<{ goals?: EditorGoal[] }>(b, '/v1/editor/goals');
    const goals = body?.goals ?? [];
    if (goals.length < 2) {
      setStatus('Track at least 2 goals first — a funnel is a sequence of them (e.g. “viewed pricing” → “signed up”).', false);
      return;
    }
    setStatus('Pick the steps in order — first click = first step.');
    closeForm();
    let selection: string[] = [];
    const nameLabel = el('label', { display: 'block', fontSize: '12px', opacity: '0.85', marginTop: '8px' }, 'Funnel name');
    const nameInput = el('input', {
      display: 'block', width: '100%', marginTop: '4px', padding: '7px 9px',
      borderRadius: '8px', border: '1px solid rgba(255,255,255,0.18)',
      background: '#1f2937', color: '#fff', font: '13px system-ui, sans-serif',
    }) as HTMLInputElement;
    formHost.append(nameLabel, nameInput);
    const orderNote = el('div', { fontSize: '11px', opacity: '0.7', marginTop: '6px' }, 'Steps (click in journey order):');
    formHost.append(orderNote);
    const rows = new Map<string, HTMLButtonElement>();
    const renderOrder = (): void => {
      for (const [goalId, btn] of rows) {
        const idx = selection.indexOf(goalId);
        const name = goals.find((g) => g.goal_id === goalId)?.display_name ?? goalId;
        btn.textContent = idx === -1 ? name : `${idx + 1}. ${name}`;
        btn.style.background = idx === -1 ? '#374151' : '#6366f1';
      }
    };
    for (const g of goals) {
      const row = el('button', { ...btnStyle('#374151'), textAlign: 'left' }) as HTMLButtonElement;
      rows.set(g.goal_id, row);
      row.onclick = () => {
        selection = toggleStepSelection(selection, g.goal_id);
        renderOrder();
      };
      formHost.append(row);
    }
    renderOrder();
    const saveBtn = el('button', btnStyle('#6366f1'), 'Save funnel') as HTMLButtonElement;
    const cancelBtn = el('button', { ...btnStyle('transparent'), opacity: '0.6' }, 'Cancel') as HTMLButtonElement;
    cancelBtn.onclick = closeForm;
    saveBtn.onclick = async () => {
      const built = buildDraftPayload(nameInput.value, selection);
      if (!built.ok) { setStatus(`⚠ ${built.error}`, false); return; }
      setStatus('Saving…');
      const r = await save(b, `/v1/editor/funnels/${encodeURIComponent(built.funnelId)}`, built.body);
      if (r.r === 'ok') { emit('draft_saved', { kind: 'funnel' }); closeForm(); offerFunnelPublish(built.funnelId); }
      reportSave(r, '✓ Funnel saved as a draft. Click “Turn the funnel on” to start measuring.');
    };
    formHost.append(saveBtn, cancelBtn);
  };

  attachFunnelBtn.onclick = async () => {
    const slotId = pendingPublishSlotId;
    if (!slotId) return;
    setStatus('Loading funnels…');
    const body = await fetchEditorJson<{ funnels?: EditorFunnel[] }>(b, '/v1/editor/funnels');
    const funnels = body?.funnels ?? [];
    if (funnels.length === 0) {
      setStatus('No funnels yet — click “Set up a funnel” first.', false);
      return;
    }
    const goalsBody = await fetchEditorJson<{ goals?: EditorGoal[] }>(b, '/v1/editor/goals');
    const goalNames = new Map((goalsBody?.goals ?? []).map((g) => [g.goal_id, g.display_name]));
    openForm(
      [
        { key: 'funnel', label: 'Funnel', type: 'select', options: funnels.map((f) => funnelSummaryLine(f)) },
        // funnels[0]'s steps pre-render; the change listener installed after
        // openForm() re-renders them for the picked funnel (audit SNIP-10).
        { key: 'step', label: 'Which step does this element serve?', type: 'select', options: stepOptions(funnels[0]!, goalNames).map((o) => o.label) },
      ],
      'Attach',
      async (v) => {
        const funnel = funnels.find((f) => funnelSummaryLine(f) === v.funnel) ?? funnels[0]!;
        const stepIdx = stepOptions(funnel, goalNames).findIndex((o) => o.label === v.step);
        // A blank or mismatched step must FAIL, not post stepIndex:null behind
        // a "✓ Attached" toast — that attached the slot to no step at all
        // while claiming success (audit SNIP-10).
        if (stepIdx < 0) {
          setStatus('⚠ Pick which step this element serves.', false);
          return;
        }
        setStatus('Attaching…');
        const r = await save(b, `/v1/editor/funnels/${encodeURIComponent(funnel.funnel_id)}/assign`, {
          slotId,
          stepIndex: stepIdx,
        });
        if (r.r === 'ok') closeForm();
        reportSave(r, `✓ Attached — this test now works toward “${funnel.display_name}”.`);
      },
    );
    // Re-render the step options from the SELECTED funnel: the pre-rendered
    // list is funnels[0]'s, so picking a different funnel showed the wrong
    // step labels and resolved the index against the wrong funnel (audit
    // SNIP-10).
    const funnelSel = formHost.querySelector<HTMLSelectElement>('select[data-field="funnel"]');
    const stepSel = formHost.querySelector<HTMLSelectElement>('select[data-field="step"]');
    if (funnelSel && stepSel) {
      funnelSel.addEventListener('change', () => {
        const f = funnels.find((x) => funnelSummaryLine(x) === funnelSel.value) ?? funnels[0]!;
        stepSel.length = 1; // keep the leading "— no change —" option
        for (const o of stepOptions(f, goalNames)) {
          const opt = document.createElement('option');
          opt.value = o.label;
          opt.textContent = o.label;
          stepSel.append(opt);
        }
      });
    }
  };

  styleBtn.onclick = () => {
    if (!selected || !currentLocator) return;
    emit('form_opened', { kind: 'style' });
    const loc = currentLocator;
    openForm(
      [
        { key: 'color', label: 'Text colour', type: 'color' },
        { key: 'background', label: 'Background colour', type: 'color' },
        { key: 'fontSize', label: 'Font size (e.g. 20px)' },
        { key: 'fontWeight', label: 'Font weight (e.g. 700)' },
        {
          key: 'fontFamily',
          label: detectedFonts.length
            ? `Font (this site has: ${detectedFonts.slice(0, 3).join(', ')})`
            : 'Font (e.g. Georgia, serif)',
        },
        { key: 'borderRadius', label: 'Corner radius (e.g. 8px)' },
        { key: 'textAlign', label: 'Alignment', type: 'select', options: ['left', 'center', 'right', 'justify'] },
      ],
      'Save draft',
      async (v, fieldError) => {
        const { style, errors } = buildStyleOps(v);
        // Surface a per-field reason for every rejected value instead of a false
        // "✓ Saved" (the browser would otherwise drop the illegal value silently).
        let hasError = false;
        for (const key of STYLE_KEYS) {
          fieldError(key, errors[key] ?? null);
          if (errors[key]) hasError = true;
        }
        if (hasError) { setStatus('⚠ Fix the highlighted field(s).', false); return; }
        if (Object.keys(style).length === 0) { setStatus('⚠ Enter at least one style change.', false); return; }
        const slotId = deriveSlotId('style', loc, selected!);
        setStatus('Saving…');
        const r = await save(b, `/v1/editor/slots/${encodeURIComponent(slotId)}`, {
          kind: 'arms',
          target: loc,
          draftConfig: { arms: [
            { id: 'a', displayName: 'Current look', ops: {} },
            { id: 'b', displayName: 'New look', ops: { style } },
          ] },
        });
        if (r.r === 'ok') { emit('draft_saved', { kind: 'slot' }); commitPreview(); closeForm(); offerPublish(slotId, describeElement(selected!), 'b'); }
        reportSave(r, '✓ Saved as a draft. Click “Publish” below to go live.');
      },
    );

    // Live preview: apply the candidate styles to the real element as the
    // operator types — same validation (buildStyleOps) and same property
    // whitelist (CSS_PROP) as the served ops, so what previews is what ships.
    // The snapshot is the element's inline cssText; discard restores it.
    const target = selected as HTMLElement;
    const origCss = target.style.cssText;
    previewRestore = () => { target.style.cssText = origCss; };
    const vals: Record<string, string> = {};
    const applyPreview = (): void => {
      const { style } = buildStyleOps(vals as Parameters<typeof buildStyleOps>[0]);
      target.style.cssText = origCss;
      for (const [k, v] of Object.entries(style)) {
        const prop = CSS_PROP[k];
        if (prop && cssValueSafe(v)) target.style.setProperty(prop, v.trim(), 'important');
      }
    };
    for (const key of STYLE_KEYS) {
      const field = formHost.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${key}"]`);
      if (!field) continue;
      const on = (): void => { vals[key] = field.value; applyPreview(); };
      field.addEventListener('input', on);
      field.addEventListener('change', on);
    }
    // Swatches beside the two color fields: the site's own sampled colors plus
    // white. Setting the value alone would not count — the color getter only
    // trusts touched inputs and the live preview listens on 'input' — so each
    // swatch dispatches the event the pipeline already keys on.
    // Convert up front and keep only colors the picker can hold — a sampled
    // value toHexColor can't parse would be coerced to #000000 on click.
    const swatchColors = [sitePalette?.primaryBg, sitePalette?.primaryText, '#ffffff']
      .filter((c): c is string => !!c)
      .map(toHexColor)
      .filter((c, i, all) => isHex6(c) && all.indexOf(c) === i);
    for (const key of ['color', 'background']) {
      const input = formHost.querySelector<HTMLInputElement>(`input[data-field="${key}"]`);
      if (!input) continue;
      const row = el('div', { display: 'flex', gap: '6px', marginTop: '4px' });
      for (const c of swatchColors) {
        const sw = el('button', {
          width: '22px', height: '22px', borderRadius: '6px', cursor: 'pointer',
          border: '1px solid rgba(255,255,255,0.35)', background: c, padding: '0',
        }) as HTMLButtonElement;
        sw.title = c;
        sw.onclick = () => { input.value = toHexColor(c); input.dispatchEvent(new Event('input')); };
        row.append(sw);
      }
      input.after(row);
    }
  };

  // 💡 AI suggestions (conservative by construction): the model only ever
  // PROPOSES — applying a card opens the matching form prefilled (live
  // preview included), and the operator still saves or cancels. The server
  // total-validates the model output, so a bad style value never gets here.
  // "Try it" needs the matching form OPEN and prefillable. setActiveTab is a
  // deliberate no-op on the current tab, so re-open the form explicitly when
  // it isn't on screen (e.g. the operator cancelled it and stayed on the tab).
  // Returns false — with the reason in the status line — when the element
  // can't take this kind of edit, instead of a silent nothing-happened.
  const ensureFormFor = (kind: 'text' | 'style'): boolean => {
    const btn = kind === 'text' ? textBtn : styleBtn;
    if (btn.disabled) {
      setStatus(btn.title || 'This element can’t be targeted reliably — try a heading, a button, or a whole section.', false);
      return false;
    }
    setActiveTab(kind);
    const probe = kind === 'text' ? '[data-field="alt"]' : '[data-field="color"]';
    if (!formHost.querySelector(probe)) btn.onclick?.(new MouseEvent('click') as never);
    return true;
  };

  // Clicking ✨ opens an instruction box rather than firing straight away. The
  // dashboard used to carry a separate "Test copy with AI" chat for saying what
  // you WANTED, next to an editor button that only handed back ideas — two doors
  // to the same intent, and only one of them could see the element. This is that
  // door, on the element: type what to try, or submit empty for ideas.
  const openAiPrompt = (): void => {
    if (!selected) return;
    aiHost.textContent = '';
    const box = el('div', {
      margin: '0 0 8px', padding: '9px 11px', borderRadius: '10px',
      background: 'rgba(250,204,21,0.08)', border: '1px solid rgba(250,204,21,0.3)',
    });
    const input = el('input', {
      width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: '7px',
      border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(0,0,0,0.25)',
      color: '#fff', font: '12px system-ui, sans-serif',
    }) as HTMLInputElement;
    input.type = 'text';
    input.maxLength = 300;
    input.placeholder = 'e.g. shorter and more urgent';
    input.setAttribute('data-field', 'ai-instruction');
    const go = el('button', {
      ...btnStyle('#6366f1'), display: 'inline-block', width: 'auto', margin: '8px 0 0',
      padding: '4px 10px', fontSize: '11px',
    }, 'Go') as HTMLButtonElement;
    // Named so it can be addressed unambiguously — "Go" is a substring of the
    // Goals tab label, which sits in the same panel.
    go.setAttribute('data-action', 'ai-go');
    go.onclick = () => { void runSuggest(input.value.trim()); };
    input.onkeydown = (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); go.onclick?.(new MouseEvent('click') as never); } };
    box.append(
      el('div', { fontWeight: '600', marginBottom: '4px' }, 'What should this element do differently?'),
      input,
      el('div', { opacity: '0.7', fontSize: '11px', marginTop: '4px' }, 'Leave it blank for ideas. Nothing goes live — you review and save whatever comes back.'),
      go,
    );
    aiHost.append(box);
    input.focus();
  };

  suggestBtn.onclick = () => openAiPrompt();

  const runSuggest = async (instruction: string): Promise<void> => {
    if (!selected) return;
    // Capture the request's element: the response can land after the operator
    // selects something else, and stale cards must never render — let alone
    // prefill a live preview — against the NEW element (same stale-fetch
    // guard as renderDrafts).
    const requestTarget = selected;
    suggestBtn.disabled = true;
    const oldLabel = suggestBtn.textContent;
    suggestBtn.textContent = 'Thinking…';
    aiHost.textContent = '';
    emit('form_opened', { kind: 'suggest' });
    type Suggestion =
      | { kind: 'text'; title: string; reason: string; variant: string }
      | { kind: 'style'; title: string; reason: string; style: Record<string, string> }
      | { kind: 'goal'; title: string; reason: string; goalType: 'click' | 'form_submit' };
    let body: { suggestions?: Suggestion[]; locked?: boolean; exhausted?: boolean } = {};
    // A failed call must not render as "no suggestions" — that presents a
    // retry-worthy network blip (or an expired token) as a definitive verdict.
    let failed: 'expired' | 'error' | null = null;
    try {
      const res = await fetch(`${b.apiBase}/v1/editor/suggest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          element: {
            tag: requestTarget.tagName.toLowerCase(),
            text: (requestTarget.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
          },
          pageUrl: window.location.pathname,
          ...(instruction ? { instruction: instruction.slice(0, 300) } : {}),
          ...(sitePalette ? { palette: sitePalette } : {}),
        }),
      });
      if (res.ok) body = (await res.json()) as typeof body;
      else failed = res.status === 401 ? 'expired' : 'error';
    } catch { failed = 'error'; }
    suggestBtn.disabled = false;
    suggestBtn.textContent = oldLabel;
    if (selected !== requestTarget) return; // the operator moved on mid-request
    if (failed) {
      setStatus(failed === 'expired'
        ? 'Editor session expired — reopen it from your dashboard to keep editing.'
        : '⚠ Couldn’t get suggestions — check your connection and try again.', false);
      return;
    }
    if (body.locked) { setStatus('AI suggestions aren’t included in this plan.', false); return; }
    if (body.exhausted) { setStatus('You’ve used today’s AI allowance — more tomorrow, or upgrade for a bigger daily budget.', false); return; }
    const suggestions = body.suggestions ?? [];
    if (suggestions.length === 0) {
      setStatus(instruction
        ? 'Couldn’t do that safely on this element — try asking for a smaller change, or pick a headline or a button.'
        : 'No safe suggestions for this element — try a headline, a button, or a section.', false);
      return;
    }
    const fill = (key: string, value: string): void => {
      const field = formHost.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${key}"]`);
      if (!field) return;
      field.value = value;
      field.dispatchEvent(new Event('input')); // live preview + touched flag ride this
    };
    for (const sug of suggestions) {
      const card = el('div', {
        margin: '0 0 8px', padding: '9px 11px', borderRadius: '10px', fontSize: '12px',
        background: 'rgba(250,204,21,0.08)', border: '1px solid rgba(250,204,21,0.3)',
      });
      card.append(
        el('div', { fontWeight: '600', marginBottom: '2px' }, sug.title),
        el('div', { opacity: '0.75', marginBottom: '6px' }, sug.reason),
      );
      const apply = el('button', {
        ...btnStyle('#6366f1'), display: 'inline-block', width: 'auto', margin: '0',
        padding: '4px 10px', fontSize: '11px',
      }, 'Try it') as HTMLButtonElement;
      apply.onclick = () => {
        if (selected !== requestTarget) { aiHost.textContent = ''; return; } // belt-and-braces vs. the clear in selectElement
        aiHost.textContent = '';
        if (sug.kind === 'text') {
          if (!ensureFormFor('text')) return;
          fill('alt', sug.variant);
        } else if (sug.kind === 'style') {
          if (!ensureFormFor('style')) return;
          for (const [k, v] of Object.entries(sug.style)) {
            if (k === 'color' || k === 'background') {
              // Only a value the picker can actually hold: anything else is
              // coerced to #000000 by <input type=color>, previewing and
              // saving a black the model never proposed.
              const hex = toHexColor(v);
              if (isHex6(hex)) fill(k, hex);
            } else if (k === 'textAlign') {
              // The form's select has no start/end options — they'd fill as ''.
              fill(k, v === 'start' ? 'left' : v === 'end' ? 'right' : v);
            } else {
              fill(k, v);
            }
          }
        } else {
          const useForm = sug.goalType === 'form_submit' && !formGoalBtn.disabled;
          // goalBtn disables exactly when the locator is not unique; firing it
          // anyway would save a click goal that can count the wrong element
          // (goals have no confirmation form — one click saves).
          if (!useForm && goalBtn.disabled) {
            setStatus('This element can’t be tracked reliably — select a specific button or link instead.', false);
            return;
          }
          setActiveTab('goals');
          if (useForm) formGoalBtn.onclick?.(new MouseEvent('click') as never);
          else goalBtn.onclick?.(new MouseEvent('click') as never);
        }
      };
      card.append(apply);
      aiHost.append(card);
    }
  };

  const doMove = (dir: 'up' | 'down'): void => {
    if (!selected) return;
    const parent = selected.parentElement;
    if (!parent) return;
    if (!moved) { moveOrigParent = parent; moveOrigNext = selected.nextSibling; moved = true; }
    if (dir === 'up' && prevEl) parent.insertBefore(selected, prevEl);
    else if (dir === 'down' && nextEl) parent.insertBefore(selected, nextEl.nextSibling);
    // Recompute anchors from the NEW position so the next move is correct.
    const a = computeMoveAnchors(selected, document);
    prevEl = a.prevEl; nextEl = a.nextEl; prevLocator = a.prevLocator; nextLocator = a.nextLocator;
    // Keep the moved element in sight — off-screen moves read as "nothing
    // happened", which is exactly what made moving feel broken.
    try { selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* older browsers */ }
    positionSelectionRing();
    showMovePreviewControls(true);
    setStatus('Previewing the new position — keep moving, save, or undo.');
  };
  moveUpBtn.onclick = () => doMove('up');
  moveDownBtn.onclick = () => doMove('down');

  undoBtn.onclick = () => {
    undoMove();
    setStatus('Move undone — back to the original position.');
  };

  saveArrangeBtn.onclick = async () => {
    // Guard on selectedUnique too: a non-unique target would POST a draft that
    // never resolves (a permanent no-op arm) despite a "Saved" confirmation.
    if (!selected || !currentLocator || !moved || !selectedUnique) return;
    // Encode the resting position relative to whichever neighbor resolves now.
    const opKey = prevLocator ? 'moveAfter' : 'moveBefore';
    const anchor = prevLocator ?? nextLocator;
    if (!anchor) { setStatus('⚠ Couldn’t anchor the new position — nudge it next to a section with an id.', false); return; }
    const slotId = deriveSlotId('move', currentLocator, selected);
    setStatus('Saving…');
    const r = await save(b, `/v1/editor/slots/${encodeURIComponent(slotId)}`, {
      kind: 'arms',
      target: currentLocator,
      draftConfig: { arms: [{ id: 'a', ops: {} }, { id: 'b', ops: { [opKey]: anchor } }] },
    });
    if (r.r === 'ok') {
      emit('draft_saved', { kind: 'move' });
      // Commit the preview: the moved DOM is the new baseline, so clear undo state.
      moved = false; moveOrigParent = null; moveOrigNext = null;
      showMovePreviewControls(false);
      offerPublish(slotId, describeElement(selected), 'b');
    }
    reportSave(r, '✓ Saved as a draft. Click “Publish” below to go live.');
  };

  const teardown = (): void => {
    emit('editor_closed');
    flushTelemetry();
    window.removeEventListener('pagehide', flushTelemetry);
    if (telemetryTimer) clearTimeout(telemetryTimer);
    // Both preview kinds: discardPreview restores text/style, undoMove puts a
    // previewed move back — without it closing mid-move left the page visibly
    // rearranged until reload.
    undoMove();
    discardPreview();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onReposition, true);
    window.removeEventListener('resize', onReposition);
    clearTargetHighlights(document);
    document.getElementById(STYLE_ID)?.remove(); // the keyframes sheet is editor-only
    highlight.remove();
    selectionRing.remove();
    panel.remove();
    bubble.remove();
    // Drop the in-memory bearer token and the restrictive-referrer meta the
    // snippet injected: leaving __sentientEditor around keeps the raw token
    // reachable from the page after the editor is closed, and the orphaned
    // <meta name="referrer" content="no-referrer"> would silently keep altering
    // the site's referrer policy on the normal (non-editor) page.
    (window as unknown as { __sentientEditor?: unknown }).__sentientEditor = null;
    document.querySelector('meta[data-sentient-editor]')?.remove();
    // Explicit close is intentional — drop the cached token so a reload of this
    // tab returns to the normal (non-editor) page instead of re-mounting.
    clearCachedEditorToken();
  };
  // Close is instant and unrecoverable (it drops the cached token) — with
  // unsaved work in flight, the first click warns and the second confirms.
  let closeArmed = false;
  closeBtn.onclick = () => {
    if ((formDirty || moved) && !closeArmed) {
      closeArmed = true;
      setStatus('⚠ Unsaved changes — click “Close editor” again to discard them.', false);
      return;
    }
    teardown();
  };

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  // The selection ring is position:fixed — track scroll/resize so it stays
  // pinned to the selected element.
  window.addEventListener('scroll', onReposition, true);
  window.addEventListener('resize', onReposition);

  renderActiveTab();
  emit('editor_opened');
}

function btnStyle(bg: string): Partial<CSSStyleDeclaration> {
  return {
    display: 'block', width: '100%', marginTop: '8px', padding: '8px 10px',
    borderRadius: '8px', border: 'none', background: bg, color: '#fff',
    font: '13px system-ui, sans-serif', cursor: 'pointer', textAlign: 'left',
  };
}

const PREVIEW_BAR_ID = 'sentient-preview-bar';

type PreviewSlotRow = {
  slot_id: string;
  kind: string;
  target: unknown;
  display_name?: string | null;
  draft_config?: { arms?: Array<{ id: string; displayName?: string; ops: SlotOps }> } | null;
  published_config?: { arms?: Array<{ id: string; displayName?: string; ops: SlotOps }> } | null;
};

/** Per-variant preview mode (?sentient_preview=<slotId>[&sentient_arm=<id>]):
 *  render the component with one variant's ops injected, plus a floating bar
 *  with a chip per variant. Switching variants NAVIGATES (full reload) so every
 *  variant applies to a clean DOM baseline — ops like text replacement are
 *  destructive, and in-place undo bookkeeping buys nothing here. Drafts are
 *  previewable because the editor-token slots endpoint serves draft configs. */
async function mountPreview(b: Boot, slotId: string): Promise<void> {
  // One-shot 'previewed' event — the preview bar lives outside mount()'s
  // batched emitter, and a single event doesn't need one.
  try {
    void fetch(`${b.apiBase}/v1/editor/telemetry`, {
      method: 'POST',
      keepalive: true,
      headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ kind: 'previewed' }] }),
    }).catch(() => undefined);
  } catch { /* fail-safe */ }
  let slot: PreviewSlotRow | null = null;
  try {
    const res = await fetch(`${b.apiBase}/v1/editor/slots`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    if (res.ok) {
      const body = (await res.json()) as { slots?: PreviewSlotRow[] };
      slot = (body.slots ?? []).find((s) => s.slot_id === slotId && s.kind === 'arms') ?? null;
    }
  } catch { /* handled below */ }

  const bar = el('div', {
    position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647',
    display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderRadius: '12px',
    maxWidth: '90vw', flexWrap: 'wrap',
    background: '#111827', color: '#fff', font: '13px system-ui, sans-serif',
    border: '1px solid rgba(99,102,241,0.55)', boxShadow: '0 10px 34px rgba(0,0,0,0.45)',
  });
  bar.id = PREVIEW_BAR_ID;
  const exit = el('button', {
    padding: '4px 10px', borderRadius: '999px', border: '1px solid rgba(255,255,255,0.3)',
    background: 'transparent', color: '#fff', font: '12px system-ui, sans-serif',
    cursor: 'pointer', opacity: '0.7',
  }, 'Exit preview') as HTMLButtonElement;
  exit.onclick = () => {
    clearCachedEditorToken();
    const url = new URL(location.href);
    for (const p of ['sentient_editor', 'sentient_preview', 'sentient_arm']) url.searchParams.delete(p);
    location.assign(url.toString());
  };
  // Previews launched from the editor's Drafts tab return to the editor: the
  // token stays cached, so stripping only the preview params re-mounts it.
  // "Exit preview" remains the leave-everything path the dashboard flow uses.
  const back = el('button', {
    padding: '4px 10px', borderRadius: '999px', border: '1px solid rgba(255,255,255,0.3)',
    background: '#6366f1', color: '#fff', font: '12px system-ui, sans-serif', cursor: 'pointer',
  }, 'Back to editor') as HTMLButtonElement;
  back.onclick = () => {
    const url = new URL(location.href);
    for (const p of ['sentient_preview', 'sentient_arm']) url.searchParams.delete(p);
    location.assign(url.toString());
  };

  const arms = (slot?.draft_config?.arms ?? slot?.published_config?.arms) ?? [];
  if (!slot || arms.length === 0) {
    bar.append(el('span', {}, 'Couldn’t load this preview — reopen it from your dashboard.'), back, exit);
    (document.body ?? document.documentElement).append(bar);
    return;
  }

  const requestedArm = new URLSearchParams(location.search).get('sentient_arm');
  // Default = the first non-original variant: previewing THE CHANGE is the point.
  const arm = arms.find((a) => a.id === requestedArm) ?? arms[1] ?? arms[0]!;
  bar.append(el('span', { fontWeight: '700' }, `Previewing: ${slot.display_name ?? slot.slot_id}`));

  const target = slot.target && typeof slot.target === 'object'
    ? resolveLocatorOne(slot.target as CompoundLocator, document)
    : null;
  if (!target) {
    bar.append(el('span', { opacity: '0.85' },
      '— we couldn’t find this component on this page. It may live on another page, or the page changed.'));
  } else {
    applyOps(target, arm.ops, `preview-${slot.slot_id}`, document);
    try { target.scrollIntoView({ block: 'center' }); } catch { /* older browsers */ }
    for (const a of arms) {
      const chip = el('button', {
        padding: '4px 10px', borderRadius: '999px', border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
        background: a.id === arm.id ? '#6366f1' : 'transparent', color: '#fff', font: '12px system-ui, sans-serif',
      }, a.displayName ?? a.id) as HTMLButtonElement;
      chip.onclick = () => {
        const url = new URL(location.href);
        url.searchParams.set('sentient_arm', a.id); // full reload = clean DOM baseline
        location.assign(url.toString());
      };
      bar.append(chip);
    }
  }
  bar.append(back, exit);
  (document.body ?? document.documentElement).append(bar);
}

async function start(): Promise<void> {
  if (typeof document === 'undefined') return;
  const b = boot();
  if (!b) return;
  const v = await verify(b);
  if (!v.ok) {
    if (v.unauthorized) {
      // Expired/invalid token (401) — a link opened after its 30-min window, or a
      // reload of a session whose token has since expired. Drop the cached token so
      // a further reload won't silently re-open the same dead session, and say so.
      clearCachedEditorToken();
      showToast(EXPIRED_MESSAGE);
    } else {
      // Any other failure (cold API worker, network blip, CORS) — previously this
      // returned silently and left a blank page, which is exactly what made a
      // first "Edit on site" click look like nothing happened. Surface it; the
      // cached token stays so a retry/reload can still recover.
      showToast(LOAD_ERROR_MESSAGE);
    }
    return; // never mounts
  }
  // Preview mode replaces the picker entirely — one component, one variant,
  // a switcher bar. Only reached with a valid editor token (drafts are private).
  const previewSlot = new URLSearchParams(location.search).get('sentient_preview');
  if (previewSlot) {
    if (!document.getElementById(PREVIEW_BAR_ID)) await mountPreview(b, previewSlot);
    return;
  }
  if (document.getElementById(PANEL_ID)) return; // already mounted
  mount(b);
  // Palette sampling (B3): re-derive from the live page on each editor open so
  // the stored palette tracks theme changes. Fire-and-forget — a failed sample
  // or save never blocks the editor, and serving degrades to neutral defaults.
  const sampled = deriveSitePalette(document);
  sitePalette = sampled;
  if (sampled) void save(b, '/v1/editor/palette', sampled);
  const targets = await fetchTargets(b); // best-effort: fetch/resolve failures never block the editor
  registerAuditTargets(targets); // Tab-cycling reads these (keyboard element picking)
  drawTargetHighlights(targets, document);
}

void start();
