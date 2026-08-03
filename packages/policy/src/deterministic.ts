/**
 * FNV-1a 32-bit hash. Same algorithm (offset basis, prime-by-shifts, >>> 0)
 * as the private hashUnit in apps/api/src/domain/holdout.ts — parity is
 * pinned by fixture in deterministic.test.ts and cross-checked against
 * assignHoldout in apps/api.
 */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in integer range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}

/**
 * Deterministic arm pick for the keyless local engine:
 * fnv1a(`${sessionId}:${slotId}`) % arms.length over the SORTED arms, so the
 * same session sees the same decision across reloads and tabs regardless of
 * declaration order.
 */
export function pickDeterministicArm(sessionId: string, slotId: string, arms: string[]): string {
  if (arms.length === 0) throw new Error('pickDeterministicArm requires at least one arm');
  const sorted = [...arms].sort();
  return sorted[fnv1a(`${sessionId}:${slotId}`) % sorted.length]!;
}

/**
 * Buckets a raw confidence float for CSS-facing use.
 * Pinned: c < 0.3 → low; c < 0.7 → medium; else high.
 * (Written NaN-safe: a non-comparable confidence must read as low.)
 */
export function confidenceBand(c: number): 'low' | 'medium' | 'high' {
  if (!(c >= 0.3)) return 'low';
  if (c < 0.7) return 'medium';
  return 'high';
}
