//
// Session-scoped interaction AGGREGATES for the browser-agent axis (spec
// 2026-09-22-agent-axis-human-verified-numbers-design.md §4.1). Counts, means
// and variances only: no per-event timestamps, no coordinates, no text. A
// raw trace is arguably a biometric; these statistics are not, and the whole
// privacy posture of the feature rests on that line staying where it is.
//
// The collector knows nothing about the network. It exposes a snapshot; the
// engagement capture decides when to emit it, under its own DNT/consent gate.

export type InteractionStats = {
  v: 1;
  active_ms: number;
  mm: number;
  /** Mousemoves per VISIBLE second, 2 dp. The count alone does not separate:
   *  a driver dispatches one mousemove per click, so `mm === 0` is false for
   *  the commonest automation stack (measured: Playwright emits 3 over a
   *  6-action script). The rate does — humans emit tens per second, drivers
   *  around one. Carried alongside `mm` so a future threshold can use either. */
  mm_rate: number;
  touches: number;
  clicks: number;
  /** How many mousedown→mouseup pairs `hold_mean`/`hold_std` rest on. Without
   *  it a zero-variance hold (a driver pressing and releasing in one tick) is
   *  indistinguishable from never having measured one at all, and the scorer
   *  would condemn the second case on the evidence of the first. */
  hold_n: number;
  hold_mean: number;
  hold_std: number;
  teleport: number;
  wheel: number;
  scroll_px: number;
  keydowns: number;
  input_chars: number;
  ik_cv: number;
  backspaces: number;
  gaps: [number, number, number, number, number, number];
  reduced_motion: boolean;
  kb_nav: number;
  renderer: 'sw' | 'hw' | 'unknown';
  vp: [number, number];
  dpr: number;
};

export type InteractionCollector = { snapshot(): InteractionStats; stop(): void };

/** Log-spaced action-gap edges (ms). Six buckets: <100, <300, <1000, <3000,
 *  <10000, >=10000. LLM agents pile into the two ends (instant bursts after
 *  model latency); humans sit in the middle. */
export const GAP_EDGES_MS: readonly number[] = [100, 300, 1000, 3000, 10000];

const TELEPORT_WINDOW_MS = 250;
const TOUCH_RECENT_MS = 1000;
const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Welford running mean/variance — one object per measured quantity, so the
 *  std of click hold and the CV of inter-key intervals cost 3 numbers each. */
type Welford = { n: number; mean: number; m2: number };
function push(w: Welford, x: number): void {
  w.n++;
  const d = x - w.mean;
  w.mean += d / w.n;
  w.m2 += d * (x - w.mean);
}
const std = (w: Welford): number => (w.n > 1 ? Math.sqrt(w.m2 / w.n) : 0);

function rendererClass(doc: Document): InteractionStats['renderer'] {
  try {
    const canvas = doc.createElement('canvas');
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as
      | (WebGLRenderingContext & { getExtension(name: string): { UNMASKED_RENDERER_WEBGL: number } | null })
      | null;
    if (!gl) return 'unknown';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '') : '';
    if (!name) return 'unknown';
    // Software rasterisers are what headless Chromium ships without a GPU.
    // Corroboration only — stealth tooling patches this string first — so the
    // scorer weights it low (spec §4.2).
    return /swiftshader|llvmpipe|softpipe|software|mesa offscreen/i.test(name) ? 'sw' : 'hw';
  } catch {
    return 'unknown';
  }
}

export function startInteractionCollector(doc: Document, now: () => number = Date.now): InteractionCollector {
  const win = doc.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
  const hold: Welford = { n: 0, mean: 0, m2: 0 };
  const interkey: Welford = { n: 0, mean: 0, m2: 0 };
  const gaps: InteractionStats['gaps'] = [0, 0, 0, 0, 0, 0];
  let mm = 0, touches = 0, clicks = 0, teleport = 0, wheel = 0, scrollPx = 0;
  let keydowns = 0, inputChars = 0, backspaces = 0, kbNav = 0;
  let lastMoveAt = -Infinity, lastTouchAt = -Infinity, downAt: number | null = null;
  let lastKeyAt: number | null = null, lastActionAt: number | null = null;
  let lastScrollY = win?.scrollY ?? 0;
  // Visible wall-clock: banked on hide, resumed on show. A hidden tab must not
  // accrue "activity", or a background tab left open all day reads as a
  // deeply engaged visitor with no mouse — the assistive-technology signature.
  let banked = 0;
  let visibleSince: number | null = doc.hidden ? null : now();

  const action = (): void => {
    const t = now();
    if (lastActionAt != null) {
      const g = t - lastActionAt;
      let i = 0;
      while (i < GAP_EDGES_MS.length && g >= GAP_EDGES_MS[i]!) i++;
      gaps[i as 0 | 1 | 2 | 3 | 4 | 5]++;
    }
    lastActionAt = t;
  };

  const onMove = (): void => { mm++; lastMoveAt = now(); };
  const onTouch = (): void => { touches++; lastTouchAt = now(); };
  const onDown = (): void => { downAt = now(); };
  const onUp = (): void => { if (downAt != null) { push(hold, now() - downAt); downAt = null; } };
  const onClick = (): void => {
    const t = now();
    clicks++;
    // A click with no pointer travel before it was placed at computed
    // coordinates — unless it was a tap, which never moves a mouse.
    if (t - lastMoveAt > TELEPORT_WINDOW_MS && t - lastTouchAt > TOUCH_RECENT_MS) teleport++;
    action();
  };
  const onWheel = (): void => { wheel++; };
  const onScroll = (): void => {
    const y = win?.scrollY ?? 0;
    scrollPx += Math.abs(y - lastScrollY);
    lastScrollY = y;
    // A scroll IS an action for gap purposes. Without this a session that
    // reads by scrolling contributes almost nothing to the gap histogram —
    // measured 3 gaps across a six-action script, far below what any shape
    // test can read.
    action();
  };
  const onKey = (e: KeyboardEvent): void => {
    const t = now();
    keydowns++;
    if (e.key === 'Backspace' || e.key === 'Delete') backspaces++;
    if (NAV_KEYS.has(e.key)) kbNav++;
    if (lastKeyAt != null) push(interkey, t - lastKeyAt);
    lastKeyAt = t;
    action();
  };
  const onInput = (e: Event): void => {
    const data = (e as InputEvent).data;
    if (typeof data === 'string') inputChars += data.length;
    action();
  };
  const onVisibility = (): void => {
    const t = now();
    if (doc.hidden) { if (visibleSince != null) { banked += t - visibleSince; visibleSince = null; } }
    else if (visibleSince == null) visibleSince = t;
  };

  const opts: AddEventListenerOptions = { passive: true, capture: true };
  doc.addEventListener('mousemove', onMove, opts);
  doc.addEventListener('touchstart', onTouch, opts);
  doc.addEventListener('touchmove', onWheel, opts);
  doc.addEventListener('mousedown', onDown, opts);
  doc.addEventListener('mouseup', onUp, opts);
  doc.addEventListener('click', onClick, opts);
  doc.addEventListener('wheel', onWheel, opts);
  doc.addEventListener('keydown', onKey as EventListener, opts);
  doc.addEventListener('input', onInput, opts);
  doc.addEventListener('visibilitychange', onVisibility);
  win?.addEventListener('scroll', onScroll, opts);

  const renderer = rendererClass(doc);
  const reducedMotion = ((): boolean => {
    try { return win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; } catch { return false; }
  })();

  return {
    snapshot(): InteractionStats {
      const t = now();
      const active = banked + (visibleSince != null ? t - visibleSince : 0);
      return {
        v: 1,
        active_ms: Math.round(active),
        mm,
        mm_rate: active > 0 ? Number(((mm * 1000) / active).toFixed(2)) : 0,
        touches, clicks,
        hold_n: hold.n,
        hold_mean: Math.round(hold.mean),
        hold_std: Math.round(std(hold)),
        teleport, wheel,
        scroll_px: Math.round(scrollPx),
        keydowns,
        input_chars: inputChars,
        ik_cv: interkey.mean > 0 ? Number((std(interkey) / interkey.mean).toFixed(2)) : 0,
        backspaces,
        gaps: [...gaps] as InteractionStats['gaps'],
        reduced_motion: reducedMotion,
        kb_nav: kbNav,
        renderer,
        vp: [win?.innerWidth ?? 0, win?.innerHeight ?? 0],
        dpr: win?.devicePixelRatio || 1,
      };
    },
    stop(): void {
      doc.removeEventListener('mousemove', onMove, opts);
      doc.removeEventListener('touchstart', onTouch, opts);
      doc.removeEventListener('touchmove', onWheel, opts);
      doc.removeEventListener('mousedown', onDown, opts);
      doc.removeEventListener('mouseup', onUp, opts);
      doc.removeEventListener('click', onClick, opts);
      doc.removeEventListener('wheel', onWheel, opts);
      doc.removeEventListener('keydown', onKey as EventListener, opts);
      doc.removeEventListener('input', onInput, opts);
      doc.removeEventListener('visibilitychange', onVisibility);
      win?.removeEventListener('scroll', onScroll, opts);
    },
  };
}
