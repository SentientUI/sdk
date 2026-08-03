// Guard against the classic footgun: a secret key (sk_…) pasted into --key gets
// written into a CLIENT-exposed env var (NEXT_PUBLIC_/VITE_/REACT_APP_) and
// shipped to every browser. Only publishable pk_ keys belong in client env.

/** True when the key is safe to expose to the browser (publishable pk_ key). */
export function isPublishableKey(key: string): boolean {
  return key.startsWith('pk_');
}

/**
 * Warn loudly (non-fatal) when the provided key is not a publishable pk_ key.
 * Undefined/empty keys are fine — that's local mode. Returns true when a warning
 * was emitted (so callers/tests can react).
 */
export function warnIfNotPublishableKey(
  key: string | undefined,
  log: (line: string) => void = (line) => console.warn(line),
): boolean {
  if (!key || isPublishableKey(key)) return false;
  const looksSecret = key.startsWith('sk_');
  log('');
  log('⚠  ============================ SECURITY WARNING ============================');
  log(`⚠  The key you passed ("${key.slice(0, 6)}…") is NOT a publishable pk_ key.`);
  if (looksSecret) {
    log('⚠  It looks like a SECRET server key (sk_…). Do NOT ship it to the browser.');
  }
  log('⚠  This CLI writes the key into a CLIENT-exposed env var, so it is bundled');
  log('⚠  into your site and visible to every visitor. Only publishable pk_ keys');
  log('⚠  belong in client env. Get your pk_ key from the SentientUI dashboard.');
  log('⚠  =======================================================================');
  log('');
  return true;
}

/**
 * Hard guard: ABORT (throw) when the provided key is not a publishable pk_ key.
 * Undefined/empty keys are fine (local mode) and pass through silently. This is
 * the fatal counterpart to warnIfNotPublishableKey — it emits the same visible
 * warning and then throws so init never writes a secret into client-exposed env.
 */
export function assertPublishableKey(
  key: string | undefined,
  log: (line: string) => void = (line) => console.error(line),
): void {
  if (warnIfNotPublishableKey(key, log)) {
    throw new Error(
      'Refusing to write a non-publishable key into a client-exposed env var. ' +
        'Only publishable pk_ keys belong in the browser bundle — pass your pk_ key ' +
        'from the SentientUI dashboard, or omit --key for local mode.',
    );
  }
}
