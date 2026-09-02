import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for the merchant secrets this app stores.
 *
 * `SentientSettings.secretKey` is a SentientUI `sk_`: full API access to that
 * merchant's project. It was written to the database in plaintext. Fly volumes
 * are encrypted at rest, so this was defence-in-depth rather than an open door —
 * but a shell on the one machine, a volume snapshot, or a stray backup exposed
 * every merchant's key at once, and there was no rotation path and no way to
 * tell whether a key had ever been read.
 *
 * AES-256-GCM, so the ciphertext is authenticated: a tampered row fails to
 * decrypt instead of yielding a silently wrong key.
 *
 * BACKWARD COMPATIBLE BY DESIGN. Rows written before this are plaintext and
 * stay readable — `decryptSecret` returns anything without the version prefix
 * unchanged, and the next save re-writes it encrypted. That means no data
 * migration and no flag day; the store converts itself as merchants save.
 */

const PREFIX = 'v1';
const ALGO = 'aes-256-gcm';

/**
 * Derives the 32-byte key from `SETTINGS_ENCRYPTION_KEY`.
 *
 * Returns null when unset, and callers then store plaintext exactly as before.
 * That is deliberate: a missing key must degrade to today's behaviour rather
 * than take the app down or, worse, write ciphertext nobody can ever decrypt.
 * The deploy runbook sets it; `settingsEncryptionEnabled()` lets the settings
 * screen say whether it is on.
 */
function encryptionKey(): Buffer | null {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!raw || raw.length < 16) return null;
  // SHA-256 of the passphrase: accepts any sufficiently long secret from the
  // platform's secret store without demanding exactly 32 raw bytes.
  return createHash('sha256').update(raw).digest();
}

export function settingsEncryptionEnabled(): boolean {
  return encryptionKey() !== null;
}

/** `v1:<iv>:<tag>:<ciphertext>`, all base64url. Plaintext when no key is set. */
export function encryptSecret(plain: string): string {
  const key = encryptionKey();
  if (!key || !plain) return plain;
  const iv = randomBytes(12); // 96-bit nonce, the GCM standard
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join(':');
}

/**
 * Inverse of encryptSecret. A value with no version prefix is returned as-is —
 * that is a row written before encryption was enabled, not an error.
 *
 * A value that IS prefixed but fails to decrypt throws: that means the key
 * changed or the row was tampered with, and silently handing back a broken key
 * would surface as confusing 401s from the SentientUI API instead of the real
 * cause.
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(`${PREFIX}:`)) return stored;
  const key = encryptionKey();
  if (!key) {
    throw new Error('SETTINGS_ENCRYPTION_KEY is not set but stored secrets are encrypted');
  }
  const [, ivB64, tagB64, dataB64] = stored.split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('malformed encrypted secret');
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}
