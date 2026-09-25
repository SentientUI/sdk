export type SnippetSlotDecl = { dims: Record<string, string[]>; target?: string; arms?: string[] };

import type { ConsentSource } from '@sentientui/core';

const CONSENT_PRESETS = ['cookiebot', 'onetrust', 'cookieyes', 'tcf', 'google-consent-mode', 'shopify'];

export type SnippetConfig = {
  apiKey: string;
  /**
   * @deprecated Unused — the project's type is set in the dashboard. Safe to omit.
   * A `context` key in `window.sentient` is still tolerated; it is simply not read.
   */
  context?: 'landing' | 'ecommerce' | 'saas' | 'marketplace';
  personaAttributes: boolean;
  /** Consent gate passthrough to core. Omitted when not declared (core defaults to true). */
  consent?: boolean;
  /** Read consent from the site's consent platform instead of `consent`:
   *  'cookiebot' | 'onetrust' | 'cookieyes' | 'tcf' | 'google-consent-mode' |
   *  'shopify', `{ cmp, … }` options, or `{ cookie, value, check, event }`.
   *  The snippet grants and revokes itself as the platform's decision changes.
   *  On a Shopify storefront with neither this nor `consent` set, 'shopify'
   *  (the Customer Privacy API) is used. */
  consentFrom?: ConsentSource;
  /** Behavior before consent — passthrough to core. */
  preConsentBehavior?: 'statistical_winner' | 'control';
  /** Verbose install-time diagnostics. Omitted (falsey) unless explicitly enabled. */
  debug?: boolean;
  /** Serve the project's published dashboard slots. Defaults to on when no slots
   *  are declared (bare `{ apiKey }` install); set explicitly to override. */
  registry?: boolean;
  /** CSP nonce for the <style>/<script> elements the snippet injects. Defaults
   *  to the nonce of a script already on the page (e.g. the snippet's own tag),
   *  so a nonce-based CSP needs no `'unsafe-inline'`. */
  nonce?: string;
  /** Override the consent-presets bundle URL (defaults to consent.global.js
   *  beside the snippet's own script src). Loaded only when a consent source
   *  is configured. */
  consentSrc?: string;
  /** Override the on-site editor bundle URL (defaults to deriving from the
   *  snippet's own script src). */
  editorSrc?: string;
  /** Override the API base for the editor overlay (defaults to the hosted API). */
  apiBase?: string;
  /** Capture per-section attention (dwell/scroll) to power personas. ON by
   *  default; set `false` to disable. Never runs for a DNT/GPC/consent-gated
   *  visitor. */
  sectionCapture?: boolean;
  /** Declared persona: the role the site already knows for this visitor —
   *  a vocabulary key string, or a function evaluated at init (e.g. reading
   *  the site's own session state). Unrecognized values are ignored
   *  server-side. Never a user id or email. */
  persona?: string;
  /** Page sections eligible for adaptive reordering: CSS selectors listed in
   *  the theme's natural order (mirrors the React `sections` prop). Selectors
   *  that don't resolve are dropped from the decide request, not errored; the
   *  returned order is applied only under the fail-safe bounds in index.ts
   *  (applyLayoutOrder). */
  sections?: string[];
  slots: Record<string, SnippetSlotDecl>;
};


function parseDims(raw: unknown): Record<string, string[]> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 4) return null;
  const dims: Record<string, string[]> = {};
  for (const [dim, values] of entries) {
    if (!Array.isArray(values) || values.length < 2 || values.length > 6) return null;
    if (!values.every((v) => typeof v === 'string')) return null;
    // '=' and '|' delimit the dims encoding (`tone=calm|size=lg`); the server
    // rejects them (validateSlotDecl) because a value like 'a=b' makes the arm
    // unparseable and the slot never learns. Drop it here too rather than send
    // a declaration that is refused.
    if (/[=|]/.test(dim) || (values as string[]).some((v) => /[=|]/.test(v))) return null;
    dims[dim] = values as string[];
  }
  return dims;
}

/** Enumerated arms for the Safe Swap rung: 2–12 unique strings, mirroring the wire schema. */
function parseArms(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 12) return null;
  if (!raw.every((v) => typeof v === 'string')) return null;
  return raw as string[];
}

function safeCall(fn: () => unknown): unknown {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Lenient, fail-safe parse of `window.sentient`. Returns null when unusable. */
export function parseSnippetConfig(raw: unknown): SnippetConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.apiKey !== 'string' || !r.apiKey.startsWith('pk_')) return null;

  const slots: Record<string, SnippetSlotDecl> = {};
  if (typeof r.slots === 'object' && r.slots !== null && !Array.isArray(r.slots)) {
    for (const [id, decl] of Object.entries(r.slots as Record<string, unknown>)) {
      if (typeof decl !== 'object' || decl === null) continue;
      const d = decl as Record<string, unknown>;
      const dims = parseDims(d.dims);
      if (!dims) continue;
      if (d.target !== undefined && typeof d.target !== 'string') continue;
      const arms = d.arms !== undefined ? parseArms(d.arms) : null;
      const slot: SnippetSlotDecl = { dims };
      if (typeof d.target === 'string') slot.target = d.target;
      if (arms) slot.arms = arms;
      slots[id] = slot;
    }
  }

  const cfg: SnippetConfig = {
    apiKey: r.apiKey,
    personaAttributes: r.personaAttributes === true,
    slots,
  };
  // Additive fields — only present when declared, so callers/tests that omit them
  // still deep-equal the base shape.
  // Consent config fails CLOSED (audit N4): a declared-but-unusable value —
  // `consentFrom: 'onetrsut'`, `{ cmp: 'Cookiebot' }`, `consent: 'false'` —
  // used to be dropped, leaving no gate, so every visitor was tracked from
  // first paint because of a typo. It now gates, and says why.
  if (typeof r.consent === 'boolean') cfg.consent = r.consent;
  else if (r.consent !== undefined) failClosed('consent');
  const cf = r.consentFrom as unknown;
  if (typeof cf === 'string' && CONSENT_PRESETS.includes(cf)) cfg.consentFrom = cf as ConsentSource;
  else if (cf && typeof cf === 'object' && !Array.isArray(cf)) {
    const o = cf as Record<string, unknown>;
    const ok =
      (typeof o.cmp === 'string' && CONSENT_PRESETS.includes(o.cmp)) ||
      (o.cmp === undefined && (typeof o.cookie === 'string' || typeof o.check === 'function'));
    if (ok) cfg.consentFrom = o as ConsentSource;
    else failClosed('consentFrom');
  } else if (cf !== undefined) failClosed('consentFrom');
  function failClosed(key: string): void {
    cfg.consent = false;
    console.warn(`[sentient] invalid ${key} — tracking stays OFF until it is fixed (sentient-ui.com/docs#consent).`);
  }
  if (r.preConsentBehavior === 'statistical_winner' || r.preConsentBehavior === 'control') {
    cfg.preConsentBehavior = r.preConsentBehavior;
  }
  if (r.debug === true) cfg.debug = true;
  if (typeof r.registry === 'boolean') cfg.registry = r.registry;
  if (typeof r.editorSrc === 'string') cfg.editorSrc = r.editorSrc;
  if (typeof r.consentSrc === 'string') cfg.consentSrc = r.consentSrc;
  if (typeof r.nonce === 'string' && r.nonce !== '') cfg.nonce = r.nonce;
  if (typeof r.apiBase === 'string') cfg.apiBase = r.apiBase;
  if (typeof r.sectionCapture === 'boolean') cfg.sectionCapture = r.sectionCapture;
  // Function form is evaluated ONCE here (fail-safe: a throwing or non-string
  // getter is a missing declaration, never an error) so downstream only ever
  // sees a plain string. Personas are locked per visit anyway — re-evaluating
  // later could not change the decision.
  const declaredPersona =
    typeof r.persona === 'function' ? safeCall(r.persona as () => unknown) : r.persona;
  if (typeof declaredPersona === 'string' && declaredPersona.trim() !== '') {
    cfg.persona = declaredPersona;
  }
  // Sections: non-empty selector strings only; fewer than two can't reorder,
  // so a single entry is treated as undeclared. Capped at 50 like the server's
  // decide schema, so an oversized list degrades instead of 400ing the decide.
  if (Array.isArray(r.sections)) {
    const sections = (r.sections as unknown[])
      .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      .slice(0, 50);
    if (sections.length >= 2) cfg.sections = sections;
  }

  return cfg;
}
