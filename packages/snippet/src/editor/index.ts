import { resolveLocatorOne } from '../locator';
import { generateLocator, resolvesUniquely } from './locator-gen';
import { clearCachedEditorToken } from '../editor-token';
import { cssValueSafe } from '../css-guard';
import { applyOps } from '../ops';
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
export function deriveSlotId(kind: 'text' | 'style' | 'move', locator: CompoundLocator, el: Element): string {
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

async function save(b: Boot, path: string, body: unknown): Promise<SaveResult> {
  try {
    const res = await fetch(`${b.apiBase}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return 'ok';
    return res.status === 401 ? 'expired' : 'error';
  } catch {
    return 'error';
  }
}

/** Font families the site already loads, per the audit (targets endpoint).
 *  Module-scope and filled lazily after mount — the style form reads it at
 *  open time, so the label upgrades once the fetch lands. */
let detectedFonts: string[] = [];

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
    width: '320px', padding: '16px', borderRadius: '14px', background: '#111827', color: '#fff',
    font: '13px/1.4 system-ui, sans-serif', border: '1px solid rgba(99,102,241,0.55)',
    boxShadow: '0 10px 34px rgba(0,0,0,0.45)',
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
  title.append(dot, el('span', {}, 'SentientUI editor'));
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

  const sectionLabel = (label: string): HTMLElement =>
    el('div', {
      fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase',
      opacity: '0.55', marginTop: '10px', marginBottom: '2px',
    }, label);

  const textBtn = el('button', btnStyle('#6366f1'), 'Test different text here') as HTMLButtonElement;
  const styleBtn = el('button', btnStyle('#374151'), 'Change style') as HTMLButtonElement;
  const goalBtn = el('button', btnStyle('#374151'), 'Track clicks as a goal') as HTMLButtonElement;
  // Only shown when the selected element sits inside a <form> — tracks the form.
  const formGoalBtn = el('button', btnStyle('#374151'), 'Track form submissions as a goal') as HTMLButtonElement;
  // Always available (needs no selection): counts visitors reaching this page.
  const pageGoalBtn = el('button', btnStyle('#374151'), 'Track page visits as a goal') as HTMLButtonElement;
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
  for (const btn of [textBtn, styleBtn, goalBtn, moveUpBtn, moveDownBtn]) (btn as HTMLButtonElement).disabled = true;
  // Element actions stay HIDDEN until something is selected — a wall of greyed
  // buttons was the "messy" part; pre-selection the panel is just the hint plus
  // the page-visit goal (which needs no element).
  const elementButtons = [textBtn, styleBtn, goalBtn, formGoalBtn, moveUpBtn, moveDownBtn];
  for (const btn of elementButtons) btn.style.display = 'none';
  saveArrangeBtn.style.display = 'none';
  undoBtn.style.display = 'none';
  publishBtn.style.display = 'none';
  activateGoalBtn.style.display = 'none';

  panel.append(
    title, hint, pauseBtn, selectedLabel, status,
    sectionLabel('Content & style'), textBtn, styleBtn,
    sectionLabel('Track a goal'), goalBtn, formGoalBtn, pageGoalBtn,
    sectionLabel('Move'), moveUpBtn, moveDownBtn, saveArrangeBtn, undoBtn,
    publishBtn, activateGoalBtn, closeBtn,
  );

  (document.body ?? document.documentElement).append(highlight, selectionRing, panel);

  const formHost = el('div', { marginTop: '10px' });
  panel.append(formHost);

  const closeForm = (): void => { formHost.textContent = ''; };

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

  // Map a save outcome to a status line. 'expired' gets its own message so the
  // user knows a retry won't help (the token is dead) and that reopening the
  // editor is how to recover — their already-saved drafts are untouched.
  const reportSave = (r: SaveResult, okMsg: string): void => {
    if (r === 'ok') setStatus(okMsg, true);
    else if (r === 'expired') setStatus('Editor session expired — reopen it from your dashboard to save this. Your earlier changes are safe.', false);
    else setStatus('⚠ Couldn’t save — try again.', false);
  };

  // After a slot draft saves, reveal "Publish now" targeting that slot. Publishing
  // is bounded/validated server-side (validateDraftConfig) and versioned, so it's
  // reversible from the dashboard.
  let pendingPublishSlotId: string | null = null;
  const offerPublish = (slotId: string): void => {
    pendingPublishSlotId = slotId;
    publishBtn.style.display = 'block';
  };
  publishBtn.onclick = async () => {
    if (!pendingPublishSlotId) return;
    publishBtn.disabled = true;
    setStatus('Publishing…');
    const r = await save(b, `/v1/editor/slots/${encodeURIComponent(pendingPublishSlotId)}/publish`, {});
    publishBtn.disabled = false;
    if (r === 'ok') {
      setStatus('✓ Published — live for new visitors.', true);
      publishBtn.style.display = 'none';
      pendingPublishSlotId = null;
    } else if (r === 'expired') {
      setStatus('Editor session expired — reopen it from your dashboard to publish. Your saved draft is safe.', false);
    } else {
      setStatus('⚠ Couldn’t publish — try again.', false);
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

  const onClick = (e: MouseEvent): void => {
    if (pickingPaused) return;
    const t = e.target as Element | null;
    if (!t || panel.contains(t)) return;
    e.preventDefault();
    e.stopPropagation();

    undoMove(); // selecting a new element abandons any unsaved move preview
    closeForm(); // and any half-filled form for the previous element

    selected = t;
    currentLocator = generateLocator(t, document);
    const unique = resolvesUniquely(currentLocator, t, document);
    selectedUnique = unique;
    positionSelectionRing();
    selectedLabel.style.display = 'block';
    selectedLabel.textContent = `Selected: ${describeElement(t)}`;
    setStatus(unique ? '✓ Matches exactly 1 element' : '⚠ Couldn’t target this element uniquely', unique);
    // Reveal the element actions now there is something for them to act on.
    for (const btn of elementButtons) btn.style.display = 'block';
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
  };

  textBtn.onclick = () => {
    if (!selected || !currentLocator) return;
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
        if (r === 'ok') { closeForm(); offerPublish(slotId); }
        reportSave(r, '✓ Saved as a draft. Click “Publish now” to go live.');
      },
    );
  };

  // After a goal draft saves, reveal "Start tracking now" — mirrors the slot
  // save → publish shape so the whole loop finishes without the dashboard.
  let pendingGoalId: string | null = null;
  const offerGoalActivation = (goalId: string): void => {
    pendingGoalId = goalId;
    activateGoalBtn.style.display = 'block';
  };
  activateGoalBtn.onclick = async () => {
    if (!pendingGoalId) return;
    activateGoalBtn.disabled = true;
    setStatus('Activating…');
    const r = await save(b, `/v1/editor/goals/${encodeURIComponent(pendingGoalId)}/publish`, {});
    activateGoalBtn.disabled = false;
    if (r === 'ok') {
      setStatus('✓ Tracking is live — it counts from your next visitor.', true);
      activateGoalBtn.style.display = 'none';
      pendingGoalId = null;
    } else if (r === 'expired') {
      setStatus('Editor session expired — reopen it from your dashboard to activate. Your saved goal is safe.', false);
    } else {
      setStatus('⚠ Couldn’t activate — try again.', false);
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
  const saveGoal = async (
    goalId: string,
    payload: { event: 'click' | 'form_submit' | 'url_reached'; locator?: CompoundLocator; urlPattern?: string },
  ): Promise<void> => {
    setStatus('Saving…');
    const r = await save(b, `/v1/editor/goals/${encodeURIComponent(goalId)}`, payload);
    if (r === 'ok') offerGoalActivation(goalId);
    reportSave(r, '✓ Goal saved. Click “Start tracking now” to go live.');
  };

  goalBtn.onclick = () => {
    if (!selected || !currentLocator) return;
    const goalId = deriveGoalId((selected.textContent ?? '').trim() || 'element-clicked', JSON.stringify(currentLocator));
    void saveGoal(goalId, { event: 'click', locator: currentLocator });
  };

  formGoalBtn.onclick = () => {
    const form = selected?.closest('form');
    if (!form) return;
    const formLoc = generateLocator(form, document);
    const seed = form.getAttribute('id') ?? form.getAttribute('name') ?? 'form-submitted';
    void saveGoal(deriveGoalId(seed, JSON.stringify(formLoc)), { event: 'form_submit', locator: formLoc });
  };

  pageGoalBtn.onclick = () => {
    const path = window.location.pathname || '/';
    const seed = slugify(path) ? `reached-${slugify(path)}` : 'page-visited';
    void saveGoal(deriveGoalId(seed, path), { event: 'url_reached', urlPattern: path });
  };

  styleBtn.onclick = () => {
    if (!selected || !currentLocator) return;
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
        if (r === 'ok') { closeForm(); offerPublish(slotId); }
        reportSave(r, '✓ Saved as a draft. Click “Publish now” to go live.');
      },
    );
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
    if (r === 'ok') {
      // Commit the preview: the moved DOM is the new baseline, so clear undo state.
      moved = false; moveOrigParent = null; moveOrigNext = null;
      showMovePreviewControls(false);
      offerPublish(slotId);
    }
    reportSave(r, '✓ Saved as a draft. Click “Publish now” to go live.');
  };

  const teardown = (): void => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('scroll', onReposition, true);
    window.removeEventListener('resize', onReposition);
    clearTargetHighlights(document);
    highlight.remove();
    selectionRing.remove();
    panel.remove();
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
  closeBtn.onclick = teardown;

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  // The selection ring is position:fixed — track scroll/resize so it stays
  // pinned to the selected element.
  window.addEventListener('scroll', onReposition, true);
  window.addEventListener('resize', onReposition);
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

  const arms = (slot?.draft_config?.arms ?? slot?.published_config?.arms) ?? [];
  if (!slot || arms.length === 0) {
    bar.append(el('span', {}, 'Couldn’t load this preview — reopen it from your dashboard.'), exit);
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
  bar.append(exit);
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
  const targets = await fetchTargets(b); // best-effort: fetch/resolve failures never block the editor
  drawTargetHighlights(targets, document);
}

void start();
