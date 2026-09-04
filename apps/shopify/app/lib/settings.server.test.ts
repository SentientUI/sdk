import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from '../db.server';
import { decryptSecret, encryptSecret } from './secret-box';
import {
  getSettings,
  provisionSentient,
  recordForwardSuccess,
  recordTerminalDrop,
  saveSettings,
} from './settings.server';

// settings.server is the seam between the routes and the database: the sk_
// envelope, the webhook-health records that feed the merchant's drop banner,
// and the provisioning call the save button awaits. secret-box has its own
// suite; here we pin that this module actually routes secrets THROUGH it and
// that the health writers keep their never-throw / throttle contracts.

vi.mock('../db.server', () => ({
  default: {
    sentientSettings: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

const KEY = 'a-test-passphrase-long-enough-to-count';
const db = prisma as unknown as {
  sentientSettings: {
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  db.sentientSettings.updateMany.mockResolvedValue({ count: 1 });
  db.sentientSettings.upsert.mockResolvedValue({});
});

afterEach(() => {
  delete process.env.SETTINGS_ENCRYPTION_KEY;
  delete process.env.SENTIENT_API_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getSettings / saveSettings — the sk_ envelope', () => {
  it('saveSettings stores the sk_ enveloped, never in the clear', async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    await saveSettings('x.myshopify.com', 'pk_test', 'sk_live_secret');
    const args = db.sentientSettings.upsert.mock.calls[0]![0] as {
      create: { secretKey: string; publishableKey: string };
      update: { secretKey: string };
    };
    expect(args.create.secretKey).not.toContain('sk_live_secret');
    expect(args.create.secretKey.startsWith('v1:')).toBe(true);
    expect(args.update.secretKey.startsWith('v1:')).toBe(true);
    // The pk_ ships in the storefront snippet — it stays plaintext by design.
    expect(args.create.publishableKey).toBe('pk_test');
    // Round-trip through the tested secret-box, not a parallel implementation.
    expect(decryptSecret(args.create.secretKey)).toBe('sk_live_secret');
  });

  it('getSettings decrypts the stored sk_ back to plaintext for the forwarder', async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    db.sentientSettings.findUnique.mockResolvedValue({
      publishableKey: 'pk_test',
      secretKey: encryptSecret('sk_live_secret'),
      lastForwardAt: null,
      lastDropAt: null,
      lastDropReason: null,
    });
    const s = await getSettings('x.myshopify.com');
    expect(s?.secretKey).toBe('sk_live_secret');
    expect(s?.publishableKey).toBe('pk_test');
  });

  it('getSettings passes a pre-encryption plaintext row through unchanged (lazy migration)', async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    db.sentientSettings.findUnique.mockResolvedValue({
      publishableKey: 'pk_test',
      secretKey: 'sk_written_before_encryption',
      lastForwardAt: null,
      lastDropAt: null,
      lastDropReason: null,
    });
    expect((await getSettings('x.myshopify.com'))?.secretKey).toBe('sk_written_before_encryption');
  });

  it('getSettings returns null for an unconfigured shop', async () => {
    db.sentientSettings.findUnique.mockResolvedValue(null);
    expect(await getSettings('x.myshopify.com')).toBeNull();
  });
});

describe('recordTerminalDrop', () => {
  it('caps the reason at 300 chars — a huge API error body must not bloat the row or the banner', async () => {
    await recordTerminalDrop('x.myshopify.com', 'e'.repeat(1000));
    const args = db.sentientSettings.updateMany.mock.calls[0]![0] as {
      data: { lastDropReason: string; lastDropAt: Date };
    };
    expect(args.data.lastDropReason).toHaveLength(300);
    expect(args.data.lastDropAt).toBeInstanceOf(Date);
  });

  it('never throws — a failed record must not turn the drop\'s 200 into a retry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.sentientSettings.updateMany.mockRejectedValue(new Error('db down'));
    await expect(recordTerminalDrop('x.myshopify.com', 'reason')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });
});

describe('recordForwardSuccess — the write throttle', () => {
  const now = Date.now();

  it('first success (no lastForwardAt) writes', async () => {
    await recordForwardSuccess('x.myshopify.com', { lastForwardAt: null, lastDropAt: null });
    expect(db.sentientSettings.updateMany).toHaveBeenCalledTimes(1);
  });

  it('skips the write when the stored timestamp is under an hour old', async () => {
    // A busy shop must not pay a DB write per webhook; the timestamp only has
    // to be fresh enough to outrank a drop.
    await recordForwardSuccess('x.myshopify.com', {
      lastForwardAt: new Date(now - 5 * 60 * 1000),
      lastDropAt: null,
    });
    expect(db.sentientSettings.updateMany).not.toHaveBeenCalled();
  });

  it('writes despite freshness when a drop was recorded after the last forward', async () => {
    // Without this exception the banner kept warning for up to an hour after
    // the merchant had already fixed the key.
    await recordForwardSuccess('x.myshopify.com', {
      lastForwardAt: new Date(now - 5 * 60 * 1000),
      lastDropAt: new Date(now - 60 * 1000),
    });
    expect(db.sentientSettings.updateMany).toHaveBeenCalledTimes(1);
  });

  it('never throws — the forward already succeeded and must ack 200', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.sentientSettings.updateMany.mockRejectedValue(new Error('db down'));
    await expect(
      recordForwardSuccess('x.myshopify.com', { lastForwardAt: null, lastDropAt: null }),
    ).resolves.toBeUndefined();
  });
});

describe('provisionSentient', () => {
  it('POSTs an EMPTY JSON body with the sk_ — the {} is load-bearing (Fastify 400s a bodyless json content-type)', async () => {
    process.env.SENTIENT_API_URL = 'https://api.test';
    const f = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', f);
    expect(await provisionSentient('sk_test')).toBe(true);
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/provision/shopify');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer sk_test',
    });
    // Stripping the "pointless" empty body regresses FST_ERR_CTP_EMPTY_JSON_BODY.
    expect(init.body).toBe('{}');
  });

  it('aborts after 5s — the settings action awaits this, and a hung API used to hang the save button', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return { ok: true };
    }));
    await provisionSentient('sk_test');
    expect(timeout).toHaveBeenCalledWith(5_000);
  });

  it('a non-2xx answer → false (surfaces as the "save again to retry" warning)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    expect(await provisionSentient('sk_test')).toBe(false);
  });

  it('a thrown fetch (unreachable API, or the abort above) → false, never a throw', async () => {
    // Provisioning failing must not block saving keys — the merchant retries
    // by saving again.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await provisionSentient('sk_test')).toBe(false);
  });
});
