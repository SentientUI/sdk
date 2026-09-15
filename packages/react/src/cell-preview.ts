// On-site preview for generated versions (the dashboard's "Preview on your
// site" link): ?sentient_editor=<token>&sentient_preview_cell=<slotId>~<persona>
// fetches the square's PENDING (review) or live arm through the editor-token
// API and forces it through the devtools override channel — which AdaptiveSlot
// already renders IN PLACE, with the page's real CSS, and WITHOUT recording an
// exposure ('override' source is excluded from tracking by design). A floating
// bar names what is being previewed and offers Exit.
//
// Deliberately framework-light: the bar is plain DOM (no React tree to mount
// into), and everything no-ops without both params, so normal visitors pay
// one URLSearchParams read.
import { setSlotConfigOverride } from './devtools-slot-config-overrides.js';
import { setSlotOverride } from './devtools-slot-overrides.js';
import { notifyOverridesChanged } from './override-events.js';

const PARAM_TOKEN = 'sentient_editor';
const PARAM_CELL = 'sentient_preview_cell';
const BAR_ID = 'sentient-cell-preview-bar';
const PREVIEW_ARM = '__preview__';

type CellPreviewResponse = {
  status: 'review' | 'live';
  slotName: string;
  personaDisplay: string;
  content: string | null;
  blocks: unknown | null;
};

/** Start the on-site cell preview when the URL asks for one. Idempotent. */
export function maybeStartCellPreview(apiBaseUrl?: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (document.getElementById(BAR_ID)) return;
  let token: string | null;
  let cell: string | null;
  try {
    const params = new URLSearchParams(window.location.search);
    token = params.get(PARAM_TOKEN);
    cell = params.get(PARAM_CELL);
  } catch {
    return;
  }
  if (!token || !cell) return;
  const sep = cell.lastIndexOf('~');
  if (sep <= 0) return;
  const slotId = cell.slice(0, sep);
  const persona = cell.slice(sep + 1);
  const base = (apiBaseUrl ?? 'https://api.sentient-ui.com/v1').replace(/\/$/, '');

  void fetch(`${base}/editor/cell-preview?slotId=${encodeURIComponent(slotId)}&persona=${encodeURIComponent(persona)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
    .then(async (res) => {
      if (!res.ok) {
        mountBar(res.status === 401
          ? 'This preview link has expired — reopen it from your dashboard.'
          : 'Couldn’t load this preview — reopen it from your dashboard.');
        return;
      }
      const data = (await res.json()) as CellPreviewResponse;
      if (data.blocks != null) {
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
    const url = new URL(window.location.href);
    url.searchParams.delete(PARAM_TOKEN);
    url.searchParams.delete(PARAM_CELL);
    window.location.assign(url.toString());
  };
  bar.append(label, exit);
  (document.body ?? document.documentElement).append(bar);
}
