'use client';
import { useEffect, useReducer, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { PERSONAS, PERSONA_DISPLAY, confidenceBand } from '@sentientui/policy';
import { SNAPSHOT_STORAGE_KEY_PREFIX } from '@sentientui/core';
import {
  getRegistered,
  getRegisteredSlots,
  getRegisteredSections,
  subscribeRegistry,
  getRegistryVersion,
  type RegisteredSlot,
} from '../devtools-registry.js';
import { setVariantOverride, clearVariantOverride, getOverrides } from '../devtools-overrides.js';
import { setSlotOverride, clearSlotOverride, getSlotOverrides } from '../devtools-slot-overrides.js';
import { setPreviewMode, getPreviewMode } from '../preview-mode.js';
import { notifyOverridesChanged } from '../override-events.js';
import { readDevtoolsConfig, type DevtoolsConfig } from '../devtools-config.js';

declare const process: { env?: { NODE_ENV?: string } } | undefined;
const IS_PROD = typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';
const DEFAULT_API_BASE_URL = 'https://api.sentient-ui.com/v1';

export const LOCAL_MODE_DEVTOOLS_BANNER =
  'Local mode — decisions are simulated; add a key to learn from real traffic';

type OutcomeToApply = {
  assignments?: Record<string, string>;
  layoutOrder?: string[] | null;
  slots?: Record<string, string | Record<string, string>>;
  personaAttributes?: { persona: string; confidence: 'low' | 'medium' | 'high' };
};

type OverrideWindow = Window & {
  __sentient_layout_override?: string[];
  __sentient_slot_overrides?: Record<string, string | Record<string, string>>;
};

/** The order the page is rendering: a previewed override, else what was registered. */
function currentLayout(): string[] {
  const forced = (window as unknown as OverrideWindow).__sentient_layout_override;
  const registered = getRegisteredSections();
  if (!forced || forced.length === 0) return registered;
  // Registered ids the override omits still render (useLayoutOrder returns the
  // override verbatim, and the app maps whatever ids it is given), so show them
  // trailing rather than dropping them from the list you are dragging.
  return [...forced, ...registered.filter((id) => !forced.includes(id))];
}

/**
 * Move `from` to `to` within the current order and preview it.
 *
 * Writes the whole order rather than swapping neighbours: the point is to try an
 * arrangement, not to walk one block up a list one press at a time.
 */
function reorderLayout(from: number, to: number): void {
  const order = currentLayout();
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return;
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  (window as unknown as OverrideWindow).__sentient_layout_override = next;
  setPreviewMode(true); // an arrangement you are trying must not train the bandit
  notifyOverridesChanged();
}

function resetLayout(): void {
  delete (window as unknown as OverrideWindow).__sentient_layout_override;
  notifyOverridesChanged();
}

/** Apply a simulated outcome across every surface: variants, layout, slots/tokens, persona attrs. */
function applyOutcome(result: OutcomeToApply): void {
  for (const [id, variantId] of Object.entries(result.assignments ?? {})) {
    setVariantOverride(id, variantId);
  }
  const w = window as unknown as OverrideWindow;
  if (result.layoutOrder && result.layoutOrder.length > 0) {
    w.__sentient_layout_override = result.layoutOrder;
  }
  if (result.slots) {
    w.__sentient_slot_overrides = { ...(w.__sentient_slot_overrides ?? {}), ...result.slots };
  }
  if (result.personaAttributes) {
    document.documentElement.dataset.sentientPersona = result.personaAttributes.persona;
    document.documentElement.dataset.sentientConfidence = result.personaAttributes.confidence;
  }
  setPreviewMode(true); // suppress events while previewing
  notifyOverridesChanged(); // re-render layout/slot consumers
}

function readSessionId(): string {
  try {
    const match = document.cookie.match(/(?:^|; )_snt_uid=([^;]*)/);
    if (match) return decodeURIComponent(match[1]);
  } catch {
    /* ignore */
  }
  return 'devtools-preview';
}

function slotDecls(): Array<{ id: string; arms?: string[]; dims?: RegisteredSlot['dims'] }> {
  return getRegisteredSlots().map((s) => ({
    id: s.id,
    ...(s.arms ? { arms: s.arms } : {}),
    ...(s.dims ? { dims: s.dims } : {}),
  }));
}

/** Keyed mode: simulate via /v1/explain (read-only, event-free). */
async function forcePersonaKeyed(apiKey: string, apiBaseUrl: string, persona: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/explain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      persona,
      sections: getRegisteredSections().map((id) => ({ id })),
      components: getRegistered().map((c) => ({ id: c.id, variantIds: c.variantIds })),
      slots: slotDecls(),
    }),
  });
  if (!res.ok) return;
  const data = (await res.json()) as OutcomeToApply;
  applyOutcome({
    ...data,
    personaAttributes: data.personaAttributes ?? { persona, confidence: 'high' },
  });
}

/** Local mode: simulate via the deterministic local engine — zero network. */
async function forcePersonaLocal(persona: string): Promise<void> {
  const mod = await import('@sentientui/core/local');
  if (!mod.LOCAL_ENGINE_AVAILABLE) return;
  const outcome = mod
    .createLocalEngine({ sessionId: readSessionId(), forcedPersona: persona })
    .decide({
      sections: getRegisteredSections(),
      components: getRegistered().map((c) => ({ id: c.id, variantIds: c.variantIds })),
      slots: slotDecls(),
    });
  applyOutcome({
    assignments: outcome.assignments,
    layoutOrder: outcome.layoutOrder,
    slots: outcome.slots,
    personaAttributes: {
      persona: outcome.persona,
      confidence: confidenceBand(outcome.confidence),
    },
  });
}

/** Reset: clear the decision snapshot + every override, then reload to re-decide. */
function resetAll(): void {
  for (const id of Object.keys(getOverrides())) clearVariantOverride(id);
  const w = window as unknown as OverrideWindow;
  delete w.__sentient_layout_override;
  delete w.__sentient_slot_overrides;
  delete document.documentElement.dataset.sentientPersona;
  delete document.documentElement.dataset.sentientConfidence;
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(SNAPSHOT_STORAGE_KEY_PREFIX)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  setPreviewMode(false);
  notifyOverridesChanged();
  try {
    window.location.reload();
  } catch {
    /* jsdom */
  }
}

const btn = (active: boolean): CSSProperties => ({
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid #444',
  background: active ? '#3b82f6' : '#222',
  color: '#eee',
  cursor: 'pointer',
});

/** Sentient "S." wordmark, monoline — white strokes for the black launcher button. */
function SentientMark({ size = 26 }: { size?: number } = {}): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M21 9H14C11.2 9 9.8 10.8 9.8 13C9.8 15.4 11.6 16.6 14.5 16.6H18.5C20.5 16.6 20.7 18.2 20.4 19.6"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10 22H17" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="20.6" cy="22" r="2.1" fill="#fff" />
    </svg>
  );
}

export function AdaptiveDevtools({ apiKey }: { apiKey?: string } = {}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [activePersona, setActivePersona] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);
  const [, force] = useReducer((n: number) => n + 1, 0);
  // Re-render when the component/slot registry changes. useSyncExternalStore
  // (not a manual useEffect subscription) so the subscription can't go stale
  // across Next Fast Refresh — a stale listener was why the panel needed a hard
  // refresh to pick up a renamed id.
  useSyncExternalStore(subscribeRegistry, getRegistryVersion, () => 0);
  // Client-mount gate: render nothing during SSR / the first paint so the widget
  // never reads `window` on the server. Lets consumers drop `<AdaptiveDevtools/>`
  // straight into a tree without a `dynamic(..., { ssr: false })` wrapper.
  useEffect(() => setMounted(true), []);

  // Never render in production, even if imported by mistake. (Hooks run first
  // so the rules of hooks hold regardless of these early returns.)
  if (IS_PROD) return null;
  if (!mounted) return null;

  const config: DevtoolsConfig = readDevtoolsConfig() ?? {
    apiKey: apiKey ?? '',
    apiBaseUrl: DEFAULT_API_BASE_URL,
    isLocal: false,
  };
  const useLocalEngine = config.isLocal || !config.apiKey;
  const components = getRegistered();
  const slots = getRegisteredSlots();
  const overrides = getOverrides();
  const slotOverrides = getSlotOverrides();
  const sections = currentLayout();
  const layoutForced = (window as unknown as OverrideWindow).__sentient_layout_override !== undefined;

  function onReorder(from: number, to: number): void {
    reorderLayout(from, to);
    force();
  }
  function onResetLayout(): void {
    resetLayout();
    maybeExitPreview();
    force();
  }

  // Preview mode stays on while ANY override (variant, slot or layout) is
  // active. Omitting layout here let clearing the last variant re-enable event
  // recording while a previewed section order was still on screen.
  function maybeExitPreview(): void {
    if (
      Object.keys(getOverrides()).length === 0 &&
      Object.keys(getSlotOverrides()).length === 0 &&
      (window as unknown as OverrideWindow).__sentient_layout_override === undefined
    ) {
      setPreviewMode(false);
    }
  }

  function choose(id: string, variantId: string): void {
    setVariantOverride(id, variantId);
    setPreviewMode(true);
    notifyOverridesChanged();
    force();
  }
  function resetVariant(id: string): void {
    clearVariantOverride(id);
    maybeExitPreview();
    notifyOverridesChanged();
    force();
  }
  function chooseSlotArm(id: string, arm: string): void {
    setSlotOverride(id, arm);
    setPreviewMode(true);
    notifyOverridesChanged();
    force();
  }
  function chooseSlotDim(id: string, dim: string, value: string, dims: RegisteredSlot['dims']): void {
    const current = getSlotOverrides()[id];
    // Merge onto the existing forced object, or seed from each dim's baseline
    // (first value) so unset dims stay at baseline instead of vanishing.
    const next: Record<string, string> =
      current && typeof current === 'object'
        ? { ...current }
        : Object.fromEntries(Object.entries(dims ?? {}).map(([d, values]) => [d, values[0]!]));
    next[dim] = value;
    setSlotOverride(id, next);
    setPreviewMode(true);
    notifyOverridesChanged();
    force();
  }
  function resetSlot(id: string): void {
    clearSlotOverride(id);
    maybeExitPreview();
    notifyOverridesChanged();
    force();
  }
  function choosePersona(persona: string): void {
    setActivePersona(persona);
    const apply = useLocalEngine
      ? forcePersonaLocal(persona)
      : forcePersonaKeyed(config.apiKey, config.apiBaseUrl, persona);
    void apply.then(force);
  }

  return (
    <div style={{ position: 'fixed', bottom: 16, right: 16, zIndex: 2147483647, fontFamily: 'system-ui' }}>
      {/* Panel stays mounted and animates in/out from the button's corner, so the
          launcher below never shifts. transform-origin is the button (bottom-right). */}
      <div
        aria-hidden={!open}
        style={{
          position: 'absolute',
          bottom: 52,
          right: 0,
          transformOrigin: 'bottom right',
          transition: 'opacity .18s ease, transform .2s cubic-bezier(.16,1,.3,1)',
          opacity: open ? 1 : 0,
          transform: open ? 'translateY(0) scale(1)' : 'translateY(6px) scale(.96)',
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        <div style={{ width: 300, maxHeight: 460, overflowY: 'auto', background: '#111', color: '#eee',
                      borderRadius: 8, padding: 12, boxShadow: '0 8px 30px rgba(0,0,0,.4)', fontSize: 12 }}>
          {config.isLocal && (
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 4,
                          padding: '6px 8px', marginBottom: 8 }}>
              {LOCAL_MODE_DEVTOOLS_BANNER}
            </div>
          )}
          <div style={{ opacity: .7, marginBottom: 8 }}>
            {components.length} component{components.length === 1 ? '' : 's'} · {getPreviewMode() ? 'preview — writing nothing' : 'live'}
          </div>
          <div style={{ borderBottom: '1px solid #333', paddingBottom: 8, marginBottom: 8 }}>
            <div style={{ opacity: .7, marginBottom: 4 }}>Preview persona</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {PERSONAS.map((p) => (
                <button key={p} onClick={() => choosePersona(p)} style={btn(activePersona === p)}>
                  {PERSONA_DISPLAY[p]}
                </button>
              ))}
              {(activePersona !== null || Object.keys(overrides).length > 0 || Object.keys(slotOverrides).length > 0) && (
                <button onClick={resetAll} style={{ ...btn(false), color: '#aaa' }}>
                  Reset
                </button>
              )}
            </div>
          </div>
          {sections.length > 0 && (
            <div style={{ borderBottom: '1px solid #333', paddingBottom: 8, marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ opacity: .7 }}>Layout — drag to reorder</span>
                {layoutForced && (
                  // Distinct accessible name: the per-variant and per-slot resets
                  // below are also labelled "reset", and three identical buttons
                  // in one panel is ambiguous to a screen reader and to tests.
                  <button
                    aria-label="Reset section order"
                    onClick={onResetLayout}
                    style={{ ...btn(false), color: '#aaa' }}
                  >
                    reset
                  </button>
                )}
              </div>
              {/* Drop-on-row inserts at that row's position, so any block can go
                  anywhere in one gesture. The whole order is written on each
                  drop — see reorderLayout. */}
              <ul aria-label="Section order" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {sections.map((id, i) => (
                  <li
                    key={id}
                    draggable
                    onDragStart={() => setDragFrom(i)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragFrom !== null) onReorder(dragFrom, i);
                      setDragFrom(null);
                    }}
                    onDragEnd={() => setDragFrom(null)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', marginBottom: 2,
                      borderRadius: 4, border: '1px solid #262626', cursor: 'grab',
                      background: dragFrom === i ? '#1e293b' : '#181818',
                      opacity: dragFrom !== null && dragFrom !== i ? .6 : 1,
                    }}
                  >
                    <span style={{ opacity: .4, minWidth: 10, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
                    <span aria-hidden="true" style={{ opacity: .35 }}>⠿</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {id}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {components.length === 0 && slots.length === 0 && sections.length === 0 && (
            <div style={{ opacity: .6 }}>No components, sections or slots on this page yet.</div>
          )}
          {components.map((c) => (
            <div key={c.id} style={{ borderTop: '1px solid #333', padding: '8px 0' }}>
              <div style={{ fontWeight: 600 }}>{c.id}{c.goal ? ` · goal: ${c.goal}` : ''}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {c.variantIds.map((v) => (
                  <button key={v} onClick={() => choose(c.id, v)} style={btn(overrides[c.id] === v)}>
                    {v}
                  </button>
                ))}
                {overrides[c.id] && (
                  <button onClick={() => resetVariant(c.id)} style={{ ...btn(false), color: '#aaa' }}>
                    reset
                  </button>
                )}
              </div>
            </div>
          ))}
          {slots.length > 0 && (
            <div style={{ borderTop: '1px solid #333', paddingTop: 8, marginTop: 4 }}>
              <div style={{ opacity: .7, marginBottom: 4 }}>Slots</div>
              {slots.map((s) => {
                const ov = slotOverrides[s.id];
                return (
                  <div key={s.id} style={{ padding: '6px 0' }}>
                    <div style={{ fontWeight: 600 }}>{s.id}</div>
                    {s.arms && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                        {s.arms.map((arm) => (
                          <button key={arm} onClick={() => chooseSlotArm(s.id, arm)} style={btn(ov === arm)}>
                            {arm}
                          </button>
                        ))}
                      </div>
                    )}
                    {s.dims && Object.entries(s.dims).map(([dim, values]) => (
                      <div key={dim} style={{ marginTop: 4 }}>
                        <div style={{ opacity: .6, fontSize: 11 }}>{dim}</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {values.map((v) => (
                            <button
                              key={v}
                              onClick={() => chooseSlotDim(s.id, dim, v, s.dims)}
                              style={btn(!!ov && typeof ov === 'object' && ov[dim] === v)}
                            >
                              {v}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                    {ov !== undefined && (
                      <button onClick={() => resetSlot(s.id)} style={{ ...btn(false), color: '#aaa', marginTop: 4 }}>
                        reset
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <button
        aria-label="Sentient DevTools"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ width: 44, height: 44, borderRadius: 12, border: '1px solid #2a2a2a', background: '#000',
                 display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                 cursor: 'pointer', boxShadow: '0 6px 18px rgba(0,0,0,.4)' }}
      >
        <SentientMark />
      </button>
    </div>
  );
}
