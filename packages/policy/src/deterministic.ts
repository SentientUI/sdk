/**
 * FNV-1a 32-bit hash: offset basis 0x811c9dc5, prime multiply by shifts,
 * >>> 0. Pinned by fixture in deterministic.test.ts. It keys the keyless
 * local engine's arm pick and the no-code capture ids, so its output must
 * never change — SDKs already in the wild compute it in the browser.
 *
 * Not a holdout hash on its own: see holdoutUnit for why a salted bucket
 * needs a finalizer on top of it.
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
 * murmur3's 32-bit finalizer (fmix32): a bijection on uint32 in which every
 * output bit depends on every input bit.
 */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The holdout bucket of (project, session) as a float in [0, 1). A session is
 * held out iff `holdoutUnit(projectId, sessionId) < holdout_rate`. The only
 * caller is apps/api `assignHoldout`, whose result is stored on the session
 * row at creation and never recomputed for an existing row (CONTRACTS §5) —
 * no SDK computes holdout locally.
 *
 * Salted by project (audit I21). The old bucket was fnv1a(sessionId) alone, so
 * an id held out in one project was held out in EVERY project at the same or
 * a higher rate: holdouts were perfectly correlated across projects instead of
 * independent draws.
 *
 * The finalizer is not decoration. Plain FNV-1a is a chain of xor and
 * odd-multiply steps that only carries information from low bits upward, and
 * the bucket reads the TOP bits. Salting it without a finalizer left two
 * projects' draws measurably dependent: phi up to 0.11 between two projects
 * at rate 0.1 on sequential ids (`session-${i}` — session ids are free-form
 * TEXT, and server-side integrations send their own), and up to 0.05 on UUIDs
 * when the salt went after the id. With fmix32 both stay inside sampling
 * noise. Independence must not depend on the ids happening to be random.
 */
export function holdoutUnit(projectId: string, sessionId: string): number {
  return fmix32(fnv1a(`${projectId}:${sessionId}`)) / 0x100000000;
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
