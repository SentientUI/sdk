/**
 * Slot declaration helpers shared by the browser client (decide) and the
 * server preload path. Pure wrappers over @sentientui/policy.
 */
import {
  canonicalArm,
  slotBaselineArm,
  slotResultFor,
  type SlotDecl,
  type SlotResult,
} from '@sentientui/policy';

/** SDK-facing slot declaration. `dims` accepts readonly arrays (`as const`). */
export type SlotDeclInput = {
  id: string;
  arms?: string[];
  dims?: Record<string, readonly string[]>;
  baseline?: string | Record<string, string>;
};

export type { SlotResult };

/**
 * Whitelists the wire fields of a slot declaration. Anything an SDK layer
 * attached (goal configs, refs, …) is stripped so it never reaches the zod
 * schema on the API. Also normalizes readonly arrays to mutable ones.
 */
export function toWireSlot(d: SlotDeclInput): SlotDecl {
  return {
    id: d.id,
    ...(d.arms ? { arms: [...d.arms] } : {}),
    ...(d.dims
      ? {
          dims: Object.fromEntries(
            Object.entries(d.dims).map(([dim, values]) => [dim, [...values]]),
          ),
        }
      : {}),
    ...(d.baseline !== undefined ? { baseline: d.baseline } : {}),
  };
}

/** The declared (or default first-declared) baseline result for a slot. */
export function baselineResultFor(d: SlotDeclInput): SlotResult {
  const decl = toWireSlot(d);
  return slotResultFor(decl, slotBaselineArm(decl));
}

/** Baseline results for a whole declaration list, keyed by slot id. */
export function baselineSlots(decls: SlotDeclInput[]): Record<string, SlotResult> {
  const out: Record<string, SlotResult> = {};
  for (const d of decls) out[d.id] = baselineResultFor(d);
  return out;
}

/**
 * Canonical arm string of a slot result: dims results encode as sorted
 * `dim=value` pairs joined with '|'; arms results are the arm id verbatim.
 */
export function armOfResult(result: SlotResult): string {
  return typeof result === 'string' ? result : canonicalArm(result);
}
