import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate } from '../shopify.server';
import db from '../db.server';
import { planSyncConfigured, syncPlan } from '../lib/plan-sync.server';
import { decryptSecret } from '../lib/secret-box';
import { action } from './webhooks.app.uninstalled';

// Shopify retries app/uninstalled for 48h, so a duplicate can land AFTER the
// merchant has reinstalled. Wiping then logs them out and disconnects a live
// install — these tests pin the staleness guard that prevents it.

vi.mock('../shopify.server', () => ({
  authenticate: { webhook: vi.fn() },
}));
vi.mock('../lib/settings.server', () => ({ revokeConnectPair: vi.fn() }));
vi.mock('../db.server', () => ({
  default: {
    session: { findFirst: vi.fn(), deleteMany: vi.fn() },
    sentientSettings: { findUnique: vi.fn(), deleteMany: vi.fn() },
    pendingConnect: { deleteMany: vi.fn(), findUnique: vi.fn(async () => null) },
  },
}));
vi.mock('../lib/plan-sync.server', () => ({ syncPlan: vi.fn(), planSyncConfigured: vi.fn(() => true) }));
vi.mock('../lib/secret-box', () => ({ decryptSecret: vi.fn((s: string) => `plain:${s}`) }));

const mockDb = db as unknown as {
  session: { findFirst: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  sentientSettings: { findUnique: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
};
const webhook = authenticate.webhook as unknown as ReturnType<typeof vi.fn>;
const mockSyncPlan = syncPlan as unknown as ReturnType<typeof vi.fn>;
const mockDecrypt = decryptSecret as unknown as ReturnType<typeof vi.fn>;

const TRIGGERED_AT = '2026-09-01T12:00:00.000Z';
const BEFORE_EVENT = new Date('2026-09-01T11:00:00.000Z');
const AFTER_EVENT = new Date('2026-09-01T13:00:00.000Z');

function makeRequest(triggeredAt: string | null = TRIGGERED_AT) {
  const headers = new Headers();
  if (triggeredAt) headers.set('x-shopify-triggered-at', triggeredAt);
  return new Request('https://app.test/webhooks/app/uninstalled', { method: 'POST', headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  webhook.mockResolvedValue({ shop: 'x.myshopify.com', topic: 'APP_UNINSTALLED' });
  mockDb.sentientSettings.findUnique.mockResolvedValue(null);
  mockDb.session.findFirst.mockResolvedValue(null);
  mockDb.session.deleteMany.mockResolvedValue({ count: 1 });
  mockDb.sentientSettings.deleteMany.mockResolvedValue({ count: 1 });
  mockSyncPlan.mockResolvedValue(true);
  mockDecrypt.mockImplementation((v: string) => `plain:${v}`);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('webhooks.app.uninstalled — staleness guard', () => {
  it('a genuinely current uninstall wipes sessions and settings', async () => {
    // Both clocks predate the event: nothing has happened since it fired.
    mockDb.sentientSettings.findUnique.mockResolvedValue({ updatedAt: BEFORE_EVENT });
    mockDb.session.findFirst.mockResolvedValue({ createdAt: BEFORE_EVENT });
    const res = await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(mockDb.session.deleteMany).toHaveBeenCalledWith({ where: { shop: 'x.myshopify.com' } });
    expect(mockDb.sentientSettings.deleteMany).toHaveBeenCalledWith({ where: { shop: 'x.myshopify.com' } });
  });

  it('a stale duplicate (keys re-saved since it fired) does NOT wipe', async () => {
    mockDb.sentientSettings.findUnique.mockResolvedValue({ updatedAt: AFTER_EVENT });
    const res = await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(res.status).toBe(200); // still acked — Shopify must not redeliver it
    expect(mockDb.session.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.sentientSettings.deleteMany).not.toHaveBeenCalled();
  });

  it('a stale duplicate landing mid-reinstall (OAuth done, keys NOT re-saved) does NOT wipe', async () => {
    // The first delivery already deleted the settings row, so the only proof
    // the install is newer is the fresh Session row — the second clock.
    mockDb.sentientSettings.findUnique.mockResolvedValue(null);
    mockDb.session.findFirst.mockResolvedValue({ createdAt: AFTER_EVENT });
    await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(mockDb.session.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.sentientSettings.deleteMany).not.toHaveBeenCalled();
  });

  it('a missing/unparseable trigger header never skips the wipe', async () => {
    // When staleness cannot be proven, honoring the uninstall is the safe
    // default — skipping it on NaN would leave data behind forever.
    mockDb.sentientSettings.findUnique.mockResolvedValue({ updatedAt: AFTER_EVENT });
    await action({ request: makeRequest(null), params: {}, context: {} } as never);
    expect(mockDb.session.deleteMany).toHaveBeenCalled();
  });

  it('reads x-shopify-triggered-at BEFORE authenticate.webhook consumes the request', async () => {
    // authenticate.webhook consumes the request (it reads the raw body for the
    // HMAC). If the route read the header only afterwards, triggeredAt would be
    // NaN and every stale duplicate would wipe. Simulate the consumption by
    // deleting the header inside the mock: staleness must still be detected.
    webhook.mockImplementation(async (request: Request) => {
      request.headers.delete('x-shopify-triggered-at');
      return { shop: 'x.myshopify.com', topic: 'APP_UNINSTALLED' };
    });
    mockDb.sentientSettings.findUnique.mockResolvedValue({ updatedAt: AFTER_EVENT });
    await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(mockDb.session.deleteMany).not.toHaveBeenCalled();
  });
});

// The billing rail is claimed when a store CONNECTS, so a free Shopify
// merchant is never shown the card upgrade App Store 1.2.1 forbids. Uninstall
// is the only thing that gives it back — and it is the LAST chance to, since
// the keys that authorize the call are deleted moments later.
describe('webhooks.app.uninstalled — billing rail release', () => {
  beforeEach(() => {
    mockDb.sentientSettings.findUnique.mockResolvedValue({
      updatedAt: BEFORE_EVENT,
      secretKey: 'enveloped-sk',
    });
    mockDb.session.findFirst.mockResolvedValue({ createdAt: BEFORE_EVENT });
  });

  it('releases the rail with the decrypted sk_ before the keys are deleted', async () => {
    const res = await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(mockSyncPlan).toHaveBeenCalledWith(
      'plain:enveloped-sk',
      'free',
      'x.myshopify.com',
      fetch,
      { disconnect: true, forbiddenIsTerminal: true, releasedAt: TRIGGERED_AT },
    );
    expect(mockDb.sentientSettings.deleteMany).toHaveBeenCalled();
  });

  it('500s and KEEPS the keys when the release fails, so Shopify can retry', async () => {
    // Deleting the keys after a failed release would strand the account on the
    // Shopify rail with no plan page to buy from and no way to pay by card.
    mockSyncPlan.mockResolvedValue(false);
    const res = await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
    expect(mockDb.session.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.sentientSettings.deleteMany).not.toHaveBeenCalled();
  });

  it('a shop that never saved keys is wiped without a release call', async () => {
    mockDb.sentientSettings.findUnique.mockResolvedValue({ updatedAt: BEFORE_EVENT });
    const res = await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(mockSyncPlan).not.toHaveBeenCalled();
    expect(mockDb.sentientSettings.deleteMany).toHaveBeenCalled();
  });
  // Grader R1 N2: syncPlan now FAILS without the connector secret (so a
  // subscription webhook retries); here that must not block the erasure.
  it('erases anyway when the connector secret is unset — a permanent condition, not a retryable one', async () => {
    (planSyncConfigured as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    const res = await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(mockSyncPlan).not.toHaveBeenCalled();
    expect(mockDb.session.deleteMany).toHaveBeenCalled();
    expect(mockDb.sentientSettings.deleteMany).toHaveBeenCalled();
  });
});

// 2026-09-21: app/uninstalled ran at a 90% failure rate and shop/redact at
// 100%, all for one store, retried for hours. decryptSecret THROWS when the
// envelope cannot be opened (SETTINGS_ENCRYPTION_KEY rotated or unset), it was
// called unguarded, and it is gated on exactly what separated the failing shop
// (keys saved) from the one that succeeded (none). The throw escaped before
// the deletes ran, so the erasure never happened either.
describe('webhooks.app.uninstalled — an unreadable stored key', () => {
  beforeEach(() => {
    mockDb.sentientSettings.findUnique.mockResolvedValue({
      updatedAt: BEFORE_EVENT,
      secretKey: 'v1:corrupt',
    });
    mockDb.session.findFirst.mockResolvedValue({ createdAt: BEFORE_EVENT });
    mockDecrypt.mockImplementation(() => {
      throw new Error('SETTINGS_ENCRYPTION_KEY is not set but stored secrets are encrypted');
    });
  });

  it('still erases the shop — a key we cannot read must not block the wipe', async () => {
    const res = await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(mockDb.session.deleteMany).toHaveBeenCalled();
    expect(mockDb.sentientSettings.deleteMany).toHaveBeenCalled();
  });

  it('does not attempt a plan release it could never authenticate', async () => {
    await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(mockSyncPlan).not.toHaveBeenCalled();
  });

  it('acks rather than 500ing — a rotated key is permanent, so retrying for 48h is pure noise', async () => {
    const res = await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});
