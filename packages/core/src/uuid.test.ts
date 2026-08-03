import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUuidV4 } from './uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomUuidV4', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses crypto.randomUUID when available', () => {
    const spy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('11111111-2222-4333-8444-555555555555');
    expect(randomUuidV4()).toBe('11111111-2222-4333-8444-555555555555');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('falls back to a valid RFC4122 v4 UUID when crypto.randomUUID throws', () => {
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('insecure context');
    });
    expect(randomUuidV4()).toMatch(V4);
  });

  it('uses crypto.getRandomValues (a CSPRNG), not Math.random, when randomUUID is unavailable', () => {
    // Insecure contexts expose getRandomValues even when randomUUID is absent —
    // prefer it so ids never come from the non-cryptographic Math.random PRNG.
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('insecure context');
    });
    const grv = vi.spyOn(crypto, 'getRandomValues');
    const mathRandom = vi.spyOn(Math, 'random');

    const id = randomUuidV4();

    expect(id).toMatch(V4);
    expect(grv).toHaveBeenCalled();
    expect(mathRandom).not.toHaveBeenCalled();
  });

  it('never throws and still yields a valid v4 UUID when no Web Crypto exists at all', () => {
    // Last-resort Math.random builder: these ids are anonymous analytics keys
    // (not secrets), and a well-formed id the `uuid` column accepts matters more
    // than CSPRNG quality here — but it must never throw into the host page.
    vi.stubGlobal('crypto', undefined);
    expect(() => randomUuidV4()).not.toThrow();
    expect(randomUuidV4()).toMatch(V4);
  });

  it('falls back to a valid RFC4122 v4 UUID when crypto is absent (insecure context)', () => {
    // Plain http:// non-localhost pages expose no Web Crypto at all.
    vi.stubGlobal('crypto', undefined);
    expect(randomUuidV4()).toMatch(V4);
  });
});
