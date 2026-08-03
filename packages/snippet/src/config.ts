export type SnippetSlotDecl = { dims: Record<string, string[]>; target?: string; arms?: string[] };

export type SnippetConfig = {
  apiKey: string;
  context: 'landing' | 'ecommerce' | 'saas' | 'marketplace';
  personaAttributes: boolean;
  /** Consent gate passthrough to core. Omitted when not declared (core defaults to true). */
  consent?: boolean;
  /** Behavior before consent — passthrough to core. */
  preConsentBehavior?: 'statistical_winner' | 'control';
  /** Verbose install-time diagnostics. Omitted (falsey) unless explicitly enabled. */
  debug?: boolean;
  /** Serve the project's published dashboard slots. Defaults to on when no slots
   *  are declared (bare `{ apiKey }` install); set explicitly to override. */
  registry?: boolean;
  /** Override the on-site editor bundle URL (defaults to deriving from the
   *  snippet's own script src). */
  editorSrc?: string;
  /** Override the API base for the editor overlay (defaults to the hosted API). */
  apiBase?: string;
  /** Capture per-section attention (dwell/scroll) to power personas. ON by
   *  default; set `false` to disable. Never runs for a DNT/GPC/consent-gated
   *  visitor. */
  sectionCapture?: boolean;
  slots: Record<string, SnippetSlotDecl>;
};

const CONTEXTS = ['landing', 'ecommerce', 'saas', 'marketplace'] as const;

function parseDims(raw: unknown): Record<string, string[]> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 4) return null;
  const dims: Record<string, string[]> = {};
  for (const [dim, values] of entries) {
    if (!Array.isArray(values) || values.length < 2 || values.length > 6) return null;
    if (!values.every((v) => typeof v === 'string')) return null;
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

/** Lenient, fail-safe parse of `window.sentient`. Returns null when unusable. */
export function parseSnippetConfig(raw: unknown): SnippetConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.apiKey !== 'string' || !r.apiKey.startsWith('pk_')) return null;

  const context = CONTEXTS.includes(r.context as (typeof CONTEXTS)[number])
    ? (r.context as SnippetConfig['context'])
    : 'landing';

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
    context,
    personaAttributes: r.personaAttributes === true,
    slots,
  };
  // Additive fields — only present when declared, so callers/tests that omit them
  // still deep-equal the base shape.
  if (typeof r.consent === 'boolean') cfg.consent = r.consent;
  if (r.preConsentBehavior === 'statistical_winner' || r.preConsentBehavior === 'control') {
    cfg.preConsentBehavior = r.preConsentBehavior;
  }
  if (r.debug === true) cfg.debug = true;
  if (typeof r.registry === 'boolean') cfg.registry = r.registry;
  if (typeof r.editorSrc === 'string') cfg.editorSrc = r.editorSrc;
  if (typeof r.apiBase === 'string') cfg.apiBase = r.apiBase;
  if (typeof r.sectionCapture === 'boolean') cfg.sectionCapture = r.sectionCapture;

  return cfg;
}
