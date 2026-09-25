// preview.global.js — the snippet's event-free QA modes, loaded only when the
// URL asks for one (?sentient_preview=, ?sentient_persona=): no visitor ever
// downloads it. Moved out of the always-on bundle 2026-09-25 (audit S24). The
// snippet hands over the internals it drives through PreviewHost.
import type { SlotConfigEntry } from '@sentientui/core';
import type { SnippetConfig } from './config';
import { readCachedEditorToken } from './editor-token';
import { takeHashParam } from './hash-param';

type Band = 'low' | 'medium' | 'high';
type SlotResults = Record<string, string | Record<string, string>>;

/** What the snippet exposes to the preview chunk. */
export type PreviewHost = {
  cfg: SnippetConfig;
  apiBase: string;
  set(next: {
    slots?: SlotResults;
    slotConfig?: Record<string, SlotConfigEntry> | null;
    persona?: { persona: string; band: Band } | null;
    decided?: boolean;
    look?: Record<string, unknown>;
  }): void;
  apply(): void;
  installSpaHooks(): void;
  exposeGlobal(): void;
  dbg(...args: unknown[]): void;
};

const EXPLAIN_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([p, timeout]).then(
    (v) => { clearTimeout(timer); return v; },
    (e) => { clearTimeout(timer); throw e; },
  );
}

const PINNED_BOX_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'fixed', bottom: '16px', zIndex: '2147483647',
  background: '#111827', color: '#fff',
  boxShadow: '0 10px 34px rgba(0,0,0,0.45)',
};

/** Entry point the snippet calls: forced arms win over a persona preview.
 *  false = nothing to preview (a malformed param): the snippet runs an
 *  ordinary visit, as it did before the preview modes became a chunk. */
export async function runPreview(host: PreviewHost): Promise<boolean> {
  const forced = parsePreview(window.location.search);
  if (forced) {
    await previewForced(host, forced);
    return true;
  }
  const persona = parsePersonaPreview(window.location.search);
  if (persona) {
    await previewPersona(host, persona);
    host.dbg('persona preview', persona);
    return true;
  }
  return false;
}

// ?sentient_preview=hero:tone=urgent,motion=pulse|checkout:express
// Apply-only QA: force the given dims/arm for this page view. No decide, no
// events, no snapshot write. Modeled on core's ?sentient_persona= override.
export function parsePreview(search: string): SlotResults | null {
  const raw = new URLSearchParams(search).get('sentient_preview');
  if (!raw) return null;
  const out: SlotResults = {};
  for (const part of raw.split('|')) {
    // Split on the FIRST colon only, so a spec value may itself contain colons
    // (e.g. hero:label=a:b) without being truncated.
    const colon = part.indexOf(':');
    const slotId = colon === -1 ? '' : part.slice(0, colon);
    const spec = colon === -1 ? '' : part.slice(colon + 1);
    if (!slotId || !spec) continue;
    if (spec.includes('=')) {
      const dims: Record<string, string> = {};
      for (const kv of spec.split(',')) {
        const [k, v] = kv.split('=');
        if (k && v) dims[k] = v;
      }
      if (Object.keys(dims).length) out[slotId] = dims;
    } else {
      out[slotId] = spec;
    }
  }
  return Object.keys(out).length ? out : null;
}

// ?sentient_persona=<key> — the dashboard "Preview as this audience" CTA opens
// the live site with this param. Read-only preview intent (see previewPersona).
export function parsePersonaPreview(search: string): string | null {
  try {
    return new URLSearchParams(search).get('sentient_persona') || null;
  } catch {
    return null;
  }
}

const PREVIEW_BANNER_ID = 'sentient-persona-preview-banner';

/** Fixed "Previewing as X · Exit preview" affordance so an operator always knows
 *  the page is simulated, and can leave (strips the param + reloads). With
 *  `unrecognized`, says so instead — the typed value isn't in the project's
 *  persona vocabulary, so the page is showing the default experience, and the
 *  banner must not claim otherwise (B1.2). */
function showPreviewBanner(persona: string, unrecognized?: boolean): void {
  try {
    if (typeof document === 'undefined' || document.getElementById(PREVIEW_BANNER_ID)) return;
    const label = persona.charAt(0).toUpperCase() + persona.slice(1).replace(/[_-]+/g, ' ');
    const box = document.createElement('div');
    box.id = PREVIEW_BANNER_ID;
    box.setAttribute('role', 'status');
    Object.assign(box.style, PINNED_BOX_STYLE, {
      left: '50%', transform: 'translateX(-50%)',
      display: 'flex', alignItems: 'center', gap: '12px',
      padding: '10px 14px', borderRadius: '999px',
      font: '13px/1 system-ui, sans-serif',
      border: '1px solid rgba(255,255,255,0.14)',
    } as Partial<CSSStyleDeclaration>);
    const text = document.createElement('span');
    text.textContent = unrecognized
      ? `“${persona}” isn’t in your personas — showing the default experience`
      : `Previewing as ${label}`;
    const exit = document.createElement('button');
    exit.type = 'button';
    exit.textContent = 'Exit preview';
    Object.assign(exit.style, {
      cursor: 'pointer', border: '1px solid rgba(255,255,255,0.3)', background: 'transparent',
      color: '#fff', font: 'inherit', padding: '4px 10px', borderRadius: '999px',
    } as Partial<CSSStyleDeclaration>);
    exit.addEventListener('click', () => {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('sentient_persona');
        window.location.href = url.pathname + url.search + url.hash;
      } catch {
        /* fail-safe */
      }
    });
    box.appendChild(text);
    box.appendChild(exit);
    (document.body ?? document.documentElement).appendChild(box);
  } catch {
    /* fail-safe */
  }
}

/**
 * Event-free forced preview (?sentient_preview=hero:urgent): apply the given
 * arms/dims and stop. No init, no tracking, no snapshot.
 *
 * Registry (no-code) slot definitions live server-side, and this branch runs
 * BEFORE the snapshot/decide paths that populate activeSlotConfig — so without
 * the explain fetch below, applyAll only ever reaches page-declared cfg.slots
 * and applyRegistrySlots is skipped, making the whole mode a silent no-op for
 * dashboard-defined slots (the case the dashboard's preview iframe depends on).
 * Explain is the same read-only endpoint persona preview uses; `persona` is
 * omitted so it simulates the pre-portrait state. The URL always wins over the
 * arms explain would have served — this is QA, not a simulation.
 */
/**
 * Draft-read credential for preview mode: `#sentient_preview_token=` (the
 * dashboard preview iframe mints a read-only one) or the on-site editor's
 * cached token. The API used to return draft slots to the public key alone;
 * it now requires one of these, and without it previews published slots only.
 *
 * FRAGMENT, not query (grade C13): as `?sentient_preview_token=` the
 * credential went to the merchant's server, CDN and analytics logs with the
 * first request and rode the Referer of every subresource fetched before this
 * ran — stripping it here came too late for all of those. A fragment is never
 * sent over the network. The query form is NOT read any more (a dashboard
 * that still sends it previews published slots only). Stripped from the
 * visible URL at once, with the site's own `#/route` left exactly as it was
 * (grade E2 — see takeHashParam).
 */
function takePreviewToken(): string | null {
  return takeHashParam('sentient_preview_token') ?? readCachedEditorToken();
}

/** Read-only /v1/explain for both preview modes; null on any failure. */
function explain(host: PreviewHost, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const cfg = host.cfg;
  return withTimeout(
    fetch(`${host.apiBase}/v1/explain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    EXPLAIN_TIMEOUT_MS,
  );
}

async function previewForced(host: PreviewHost, forced: SlotResults): Promise<void> {
  const cfg = host.cfg;
  const registryMode = cfg.registry ?? Object.keys(cfg.slots).length === 0;
  const previewToken = takePreviewToken();
  if (registryMode) {
    // `force` makes explain resolve THESE arms' content/ops, not the ones
    // it would serve. Without it the response carries only the served
    // arm's content and the forced arm id would set data-sentient-arm
    // while the copy on the page stayed unchanged — a preview that lies.
    // Dims results are not arms, so only string results are forced.
    const data = await explain(host, {
      slotsFrom: 'registry',
      // Drafts too: previewing exists to decide whether to publish, so a
      // slot that is not live yet is precisely what needs looking at.
      includeDrafts: true,
      ...(previewToken ? { previewToken } : {}),
      force: Object.fromEntries(
        Object.entries(forced).filter((e): e is [string, string] => typeof e[1] === 'string'),
      ),
    });
    if (!data?.slotConfig) {
      // No definitions means nothing can be applied faithfully. Leave the page
      // as the visitor's own markup rather than half-applying — but still
      // expose the API, same rule as the other preview modes.
      host.exposeGlobal();
      host.dbg('preview mode: slot config unavailable — page left as-is');
      return;
    }
    // Palette + site-style parity with live serving: block arms render in the
    // site's colors (explain mirrors decide's fields).
    host.set({ slotConfig: data.slotConfig as Record<string, SlotConfigEntry>, look: data });
  }
  host.set({ slots: forced, persona: null });
  host.apply();
  host.installSpaHooks();
  // Same as editor mode: the API must exist (no-op without a client) so page
  // code calling SentientSnippet.goal(...) doesn't throw.
  host.exposeGlobal();
  host.dbg('preview mode', forced);
}

/**
 * Event-free persona preview: simulate what one audience is served via
 * /v1/explain (read-only — no impression, decision, or slot_decisions write),
 * apply it, and stop. No `init`, no tracking, no snapshot. Registry-mode sites
 * ask the server for their published slots; declared-slot sites send their own.
 */
async function previewPersona(host: PreviewHost, persona: string): Promise<void> {
  const cfg = host.cfg;
  const registryMode = cfg.registry ?? Object.keys(cfg.slots).length === 0;
  const outcome = await explain(
    host,
    registryMode
      ? { persona, slotsFrom: 'registry' }
      : { persona, slots: Object.entries(cfg.slots).map(([id, s]) => ({ id, dims: s.dims })) },
  );
  if (!outcome) {
    // The page API must exist on the failure path too (same reason as editor/
    // preview modes in run(): page code calling SentientSnippet.goal() must
    // not throw), and with no activeClient it is a no-op surface.
    host.exposeGlobal();
    host.dbg('persona preview: explain unavailable — page left as-is');
    return;
  }

  const data = outcome as {
    slots?: SlotResults;
    slotConfig?: Record<string, SlotConfigEntry>;
    persona?: string;
    personaDisplay?: string;
    recognized?: boolean;
    personaAttributes?: { persona?: string; confidence?: string };
  };
  const shown = data.personaAttributes?.persona ?? data.persona ?? persona;
  const band = (data.personaAttributes?.confidence as Band) ?? 'high';
  // Preview content is authoritative for this view (`decided`), so a later
  // reapply() may restamp copy/ops (not just reversible attributes).
  host.set({ slots: data.slots ?? {}, slotConfig: data.slotConfig ?? null, look: data, persona: { persona: shown, band }, decided: true });
  // Apply, but never beacon locator misses here — that feed can suspend slots,
  // and a read-only preview must have zero side effects.
  host.apply();
  // Same as slot preview mode: on hydrating/client-routed sites the preview is
  // wiped after first paint, and without these hooks it was never restamped —
  // the operator just saw the default page (audit SNIP-9).
  host.installSpaHooks();
  host.exposeGlobal();
  // Vocabulary echo (B1.2): only an explicit `recognized: false` shows the
  // "not one of your personas" banner — an older API omits the field, and the
  // legacy claim beats wrongly contradicting a valid key. Recognized previews
  // prefer the server's display name over the cosmetic capitalization, and the
  // unrecognized banner quotes what was TYPED, not the folded 'unknown'.
  if (data.recognized === false) showPreviewBanner(persona, true);
  else showPreviewBanner(data.personaDisplay ?? shown);
}

