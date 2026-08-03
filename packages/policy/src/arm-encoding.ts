/** A slot declaration as sent on /v1/decide — exactly one of arms|dims. */
export type SlotDecl = {
  id: string;
  arms?: string[];
  dims?: Record<string, string[]>;
  baseline?: string | Record<string, string>;
};

/** What the client receives for a slot: arm id, or per-dim values for dims slots. */
export type SlotResult = string | Record<string, string>;

/** Canonical arm string for a dims combination: sorted `dim=value` joined with '|'. */
export function canonicalArm(values: Record<string, string>): string {
  return Object.keys(values)
    .sort()
    .map((dim) => `${dim}=${values[dim]}`)
    .join('|');
}

/**
 * Inverse of canonicalArm. Returns null when the string is not a
 * dims-encoded arm (enumerated arm ids, empty, malformed, duplicate dims) —
 * callers use `parseArm(arm) !== null` to distinguish dims arms from
 * enumerated arms.
 */
export function parseArm(arm: string): Record<string, string> | null {
  if (arm.length === 0) return null;
  const out: Record<string, string> = {};
  for (const part of arm.split('|')) {
    const eq = part.indexOf('=');
    if (eq <= 0 || eq !== part.lastIndexOf('=') || eq === part.length - 1) return null;
    const dim = part.slice(0, eq);
    if (dim in out) return null;
    out[dim] = part.slice(eq + 1);
  }
  return out;
}

/** Storage key for one marginal posterior row of a dims slot. */
export function marginalArmKey(dim: string, value: string): string {
  return `${dim}=${value}`;
}

/**
 * Canonical arm string of the declared baseline, or the default baseline
 * (first arm / first value per dim) when none is declared. Assumes the decl
 * passed validateSlotDecl.
 */
export function slotBaselineArm(decl: SlotDecl): string {
  if (decl.arms) {
    return typeof decl.baseline === 'string' ? decl.baseline : decl.arms[0] ?? '';
  }
  if (decl.baseline !== undefined && typeof decl.baseline === 'object') {
    return canonicalArm(decl.baseline);
  }
  if (typeof decl.baseline === 'string') return decl.baseline; // defensive: invalid decl shape
  const defaults: Record<string, string> = {};
  for (const [dim, values] of Object.entries(decl.dims ?? {})) defaults[dim] = values[0] ?? '';
  return canonicalArm(defaults);
}

/**
 * Validates a slot declaration against the pinned rules: exactly one of
 * arms|dims; arms 2..12 (unique); dims 1..4 dims of 2..6 unique values each
 * with product ≤ 64; a declared baseline must live in the declared space.
 */
export function validateSlotDecl(decl: SlotDecl): { ok: true } | { ok: false; reason: string } {
  const hasArms = Array.isArray(decl.arms);
  const hasDims = decl.dims != null;
  if (hasArms && hasDims) return { ok: false, reason: 'declare exactly one of arms or dims (got both)' };
  if (!hasArms && !hasDims) return { ok: false, reason: 'declare exactly one of arms or dims (got neither)' };

  if (hasArms) {
    const arms = decl.arms!;
    if (arms.length < 2) return { ok: false, reason: 'arms requires at least 2 entries' };
    if (arms.length > 12) return { ok: false, reason: 'arms allows at most 12 entries' };
    if (new Set(arms).size !== arms.length) return { ok: false, reason: 'arms must be unique' };
    // '=' is reserved for the dims encoding (`dim=value`). Forbidding it in
    // enumerated arm ids keeps `parseArm(arm) !== null` a sound dims-vs-enumerated
    // discriminator — an id like "size=large" would otherwise parse as a dims arm.
    if (arms.some((a) => a.includes('='))) {
      return { ok: false, reason: "enumerated arm ids may not contain '=' (reserved for dims encoding)" };
    }
    if (decl.baseline !== undefined) {
      if (typeof decl.baseline !== 'string') {
        return { ok: false, reason: 'baseline for an arms slot must be a string' };
      }
      if (!arms.includes(decl.baseline)) {
        return { ok: false, reason: 'baseline must be one of the declared arms' };
      }
    }
    return { ok: true };
  }

  const entries = Object.entries(decl.dims!);
  if (entries.length < 1) return { ok: false, reason: 'dims requires at least 1 dimension' };
  if (entries.length > 4) return { ok: false, reason: 'dims allows at most 4 dimensions' };
  let product = 1;
  for (const [dim, values] of entries) {
    if (values.length < 2) return { ok: false, reason: `dim "${dim}" requires at least 2 values` };
    if (values.length > 6) return { ok: false, reason: `dim "${dim}" allows at most 6 values` };
    if (new Set(values).size !== values.length) return { ok: false, reason: `dim "${dim}" has duplicate values` };
    product *= values.length;
  }
  if (product > 64) {
    return { ok: false, reason: `declared space of ${product} combinations exceeds the 64 maximum` };
  }
  if (decl.baseline !== undefined) {
    if (typeof decl.baseline === 'string') {
      return { ok: false, reason: 'baseline for a dims slot must be a per-dim record' };
    }
    const baseline = decl.baseline;
    const dimKeys = entries.map(([d]) => d).sort();
    const baseKeys = Object.keys(baseline).sort();
    if (dimKeys.join(' ') !== baseKeys.join(' ')) {
      return { ok: false, reason: 'baseline must set every declared dim exactly once' };
    }
    for (const [dim, values] of entries) {
      if (!values.includes(baseline[dim]!)) {
        return { ok: false, reason: `baseline value for dim "${dim}" is not declared` };
      }
    }
  }
  return { ok: true };
}

/**
 * Decodes a stored/served arm for the client: dims slot → parsed per-dim
 * record (falling back to the baseline record if the arm fails to parse);
 * arms slot → the arm id verbatim.
 */
export function slotResultFor(decl: SlotDecl, arm: string): SlotResult {
  if (decl.dims != null) {
    return parseArm(arm) ?? parseArm(slotBaselineArm(decl)) ?? {};
  }
  return arm;
}
