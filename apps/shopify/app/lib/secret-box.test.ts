import { describe, expect, it, afterEach } from 'vitest';
import { encryptSecret, decryptSecret, settingsEncryptionEnabled } from './secret-box';

// The stored `sk_` is full API access to a merchant's SentientUI project and
// was written in plaintext, so a shell on the one machine — or a volume
// snapshot — exposed every merchant's key at once.

const KEY = 'a-test-passphrase-long-enough-to-count';

afterEach(() => {
  delete process.env.SETTINGS_ENCRYPTION_KEY;
});

describe('secret envelope', () => {
  it('round-trips a secret and never stores it in the clear', () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    const stored = encryptSecret('sk_live_abcdef123456');
    expect(stored).not.toContain('sk_live_abcdef123456');
    expect(stored.startsWith('v1:')).toBe(true);
    expect(decryptSecret(stored)).toBe('sk_live_abcdef123456');
  });

  it('produces a different ciphertext each time (fresh nonce)', () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    expect(encryptSecret('sk_same')).not.toBe(encryptSecret('sk_same'));
  });

  it('reads a legacy plaintext row unchanged, so no data migration is needed', () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    // Written before encryption existed: no version prefix.
    expect(decryptSecret('sk_written_before_encryption')).toBe('sk_written_before_encryption');
  });

  it('degrades to plaintext when no key is configured, rather than failing', () => {
    // A missing key must behave exactly as before, not take the app down or
    // write ciphertext nobody can decrypt later.
    expect(settingsEncryptionEnabled()).toBe(false);
    expect(encryptSecret('sk_plain')).toBe('sk_plain');
    expect(decryptSecret('sk_plain')).toBe('sk_plain');
  });

  it('refuses a tampered row instead of returning a broken key', () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    const stored = encryptSecret('sk_live_abcdef123456');
    const tampered = `${stored.slice(0, -4)}AAAA`;
    // GCM authenticates the ciphertext: a silently wrong key would surface as
    // confusing 401s from the SentientUI API rather than the real cause.
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('refuses to read an encrypted row when the key has gone missing', () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    const stored = encryptSecret('sk_live_abcdef123456');
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    expect(() => decryptSecret(stored)).toThrow(/SETTINGS_ENCRYPTION_KEY/);
  });

  it('ignores a key too short to be meaningful', () => {
    process.env.SETTINGS_ENCRYPTION_KEY = 'short';
    expect(settingsEncryptionEnabled()).toBe(false);
    expect(encryptSecret('sk_plain')).toBe('sk_plain');
  });
});
