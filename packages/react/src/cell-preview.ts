// On-site preview for generated versions (the dashboard's "Preview on your
// site" link): ?sentient_preview_cell=<slotId>~<persona>#sentient_editor_code=…
// (a one-time code exchanged for the editor token — editor-session.ts, E1)
// fetches the square's PENDING (review) or live arm through the editor-token
// API and forces it through the devtools override channel — which AdaptiveSlot
// already renders IN PLACE, with the page's real CSS, and WITHOUT recording an
// exposure ('override' source is excluded from tracking by design). A floating
// bar names what is being previewed and offers Exit.
//
// Deliberately framework-light: the bar is plain DOM (no React tree to mount
// into), and everything no-ops without both params, so normal visitors pay
// one URLSearchParams read.
import { setSlotConfigOverride, setVocabularyOverride } from './devtools-slot-config-overrides.js';
import { setSlotOverride } from './devtools-slot-overrides.js';
import { notifyOverridesChanged } from './override-events.js';
import { editorSession, editorSessionActive, endEditorSession } from './editor-session.js';
import type { ComposeArm, StyleVocabulary } from '@sentientui/core';

const PARAM_CELL = 'sentient_preview_cell';
const PARAM_REFRESH = 'sentient_refresh_region';
const BAR_ID = 'sentient-cell-preview-bar';
const PREVIEW_ARM = '__preview__';

type CellPreviewResponse = {
  status: 'review' | 'live';
  slotName: string;
  personaDisplay: string;
  content: string | null;
  blocks: unknown | null;
  edits?: unknown;
  skeletonFp?: string;
  leafToNode?: number[];
  compose?: unknown;
  vocabulary?: StyleVocabulary;
};

// "Refresh from page" (spec 2026-09-23 §4.2): the operator says the region
// changed. The capture runs INSIDE the AdaptiveSlot — only it holds the
// children the element-tree parity check needs — so this module just forces
// the original to show and leaves the request here for the slot to take.
// `session` is a promise: the token arrives by exchange after this module ran,
// but the slot's capture effect may run first and only once — holding the
// promise lets it take the request now and post when the token lands.
type RegionRefresh = { slotId: string; session: ReturnType<typeof editorSession>; base: string };
let pendingRefresh: RegionRefresh | null = null;

/** The refresh this page was opened for, if it targets `slotId`. Taken once. */
export function takeRegionRefresh(slotId: string): RegionRefresh | null {
  if (pendingRefresh?.slotId !== slotId) return null;
  const r = pendingRefresh;
  pendingRefresh = null;
  return r;
}

/** Post a trusted skeleton and tell the operator how it went. */
export function submitRegionRefresh(r: RegionRefresh, body: Record<string, unknown>): void {
  void r.session
    .then((s) => {
      if (!s || !('token' in s)) throw new Error('no editor session');
      return fetch(`${r.base}/editor/region-skeleton`, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ slotId: r.slotId, ...body }),
      });
    })
    .then((res) =>
      mountBar(res.ok ? 'Region refreshed — you can regenerate its versions now.' : 'Couldn’t refresh this region — reopen the link from your dashboard.'),
    )
    .catch(() => mountBar('Couldn’t refresh this region — check your connection and reopen the link from your dashboard.'));
}

/** Start the on-site cell preview when the URL asks for one. Idempotent. */
export function maybeStartCellPreview(apiBaseUrl?: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (document.getElementById(BAR_ID)) return;
  let cell: string | null;
  let refresh: string | null;
  try {
    const params = new URLSearchParams(window.location.search);
    cell = params.get(PARAM_CELL);
    refresh = params.get(PARAM_REFRESH);
  } catch {
    return;
  }
  if (!cell && !refresh) return;
  const base = (apiBaseUrl ?? 'https://api.sentient-ui.com/v1').replace(/\/$/, '');
  const session = editorSession(base);
  // Only an operator's session acts on these params; a visitor who lands on a
  // shared ?sentient_refresh_region= URL gets the normal page.
  if (!editorSessionActive()) return;
  if (refresh) {
    pendingRefresh = { slotId: refresh, session, base };
    // Force the original: a served version on screen is not the region.
    // 'override' records no exposure, so the refresh visit is never a trial.
    setSlotConfigOverride(refresh, { kind: 'arms' });
    setSlotOverride(refresh, PREVIEW_ARM);
    notifyOverridesChanged();
    return;
  }
  if (!cell) return;
  const sep = cell.lastIndexOf('~');
  if (sep <= 0) return;
  const slotId = cell.slice(0, sep);
  const persona = cell.slice(sep + 1);

  void session
    .then((s) => {
      // No code and nothing cached: a bare param, not an editor session.
      if (!s) return null;
      if (!('token' in s)) {
        mountBar(s.error === 401
          ? 'This preview link has expired — reopen it from your dashboard.'
          : 'Couldn’t load this preview — reopen it from your dashboard.');
        return null;
      }
      return fetch(`${base}/editor/cell-preview?slotId=${encodeURIComponent(slotId)}&persona=${encodeURIComponent(persona)}`, {
        headers: { authorization: `Bearer ${s.token}` },
      });
    })
    .then(async (res) => {
      if (!res) return;
      if (!res.ok) {
        mountBar(res.status === 401
          ? 'This preview link has expired — reopen it from your dashboard.'
          : 'Couldn’t load this preview — reopen it from your dashboard.');
        return;
      }
      const data = (await res.json()) as CellPreviewResponse;
      if (data.vocabulary && Array.isArray(data.vocabulary.entries)) setVocabularyOverride(data.vocabulary);
      if (data.compose != null) {
        setSlotConfigOverride(slotId, { kind: 'arms', compose: { [PREVIEW_ARM]: data.compose as ComposeArm } });
        setSlotOverride(slotId, PREVIEW_ARM);
      } else if (data.edits != null && typeof data.skeletonFp === 'string' && Array.isArray(data.leafToNode)) {
        setSlotConfigOverride(slotId, { kind: 'arms', edits: { edits: data.edits as never, fp: data.skeletonFp, leafToNode: data.leafToNode } });
        setSlotOverride(slotId, PREVIEW_ARM);
      } else if (data.blocks != null) {
        setSlotConfigOverride(slotId, { kind: 'arms', blocks: { [PREVIEW_ARM]: data.blocks } } as never);
        setSlotOverride(slotId, PREVIEW_ARM);
      } else if (data.content != null) {
        setSlotConfigOverride(slotId, { kind: 'arms', content: data.content });
        setSlotOverride(slotId, PREVIEW_ARM);
      } else {
        mountBar('Nothing to preview in that square yet.');
        return;
      }
      notifyOverridesChanged();
      mountBar(
        `Previewing “${data.slotName}” for ${data.personaDisplay}${data.status === 'review' ? ' — waiting for your approval' : ''}. Nothing is being tracked.`,
      );
      // Bring the slot into view once it re-renders with the forced arm.
      setTimeout(() => {
        try {
          document.querySelector(`[data-sentient-slot="${slotId}"]`)?.scrollIntoView({ block: 'center' });
        } catch {
          /* older browsers */
        }
      }, 300);
    })
    .catch(() => mountBar('Couldn’t load this preview — check your connection and reopen it from your dashboard.'));
}

function mountBar(text: string): void {
  if (document.getElementById(BAR_ID)) return;
  const bar = document.createElement('div');
  bar.id = BAR_ID;
  Object.assign(bar.style, {
    position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647',
    display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', borderRadius: '12px',
    maxWidth: '90vw', background: '#111827', color: '#fff', font: '13px system-ui, sans-serif',
    border: '1px solid rgba(139,92,246,0.6)', boxShadow: '0 10px 34px rgba(0,0,0,0.45)',
  } satisfies Partial<CSSStyleDeclaration>);
  const label = document.createElement('span');
  label.textContent = text;
  const exit = document.createElement('button');
  exit.textContent = 'Exit preview';
  Object.assign(exit.style, {
    padding: '4px 10px', borderRadius: '999px', border: '1px solid rgba(255,255,255,0.35)',
    background: 'transparent', color: '#fff', font: '12px system-ui, sans-serif', cursor: 'pointer',
  } satisfies Partial<CSSStyleDeclaration>);
  exit.onclick = () => {
    endEditorSession();
    const url = new URL(window.location.href);
    url.searchParams.delete(PARAM_CELL);
    url.searchParams.delete(PARAM_REFRESH);
    window.location.assign(url.toString());
  };
  bar.append(label, exit);
  (document.body ?? document.documentElement).append(bar);
}
