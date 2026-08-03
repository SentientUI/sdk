/** Shared RFC 4122 v4 UUID generator. */

/**
 * Returns a random RFC 4122 v4 UUID.
 *
 * Resolution order, each falling through only on absence/throw:
 *  1. `crypto.randomUUID()` — requires a **secure context** (HTTPS/localhost),
 *     so it is absent on plain `http://` (non-localhost) pages.
 *  2. `crypto.getRandomValues()` — a CSPRNG that, unlike `randomUUID`, *is*
 *     available in insecure contexts, so ids stay cryptographically random
 *     exactly where step 1 is unavailable.
 *  3. `Math.random()` — last resort only when no Web Crypto exists at all.
 *     These ids are anonymous analytics session/event keys (not secrets or
 *     authenticators), so a well-formed value the Postgres `uuid` column accepts
 *     matters more than PRNG quality here — and the generator must never throw
 *     (a missing/malformed id would break session creation and the host page).
 */
export function randomUuidV4(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to getRandomValues */
  }
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      buf[6] = (buf[6]! & 0x0f) | 0x40; // version 4
      buf[8] = (buf[8]! & 0x3f) | 0x80; // variant 10
      let out = '';
      for (let i = 0; i < 16; i++) {
        out += buf[i]!.toString(16).padStart(2, '0');
        if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
      }
      return out;
    }
  } catch {
    /* fall through to the Math.random() builder */
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
