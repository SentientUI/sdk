import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate } from '../shopify.server';
import db from '../db.server';
import { action } from './webhooks.app.uninstalled';

// Shopify retries app/uninstalled for 48h, so a duplicate can land AFTER the
// merchant has reinstalled. Wiping then logs them out and disconnects a live
// install — these tests pin the staleness guard that prevents it.

vi.mock('../shopify.server', () => ({
  authenticate: { webhook: vi.fn() },
}));
vi.mock('../db.server', () => ({
  default: {
    session: { findFirst: vi.fn(), deleteMany: vi.fn() },
    sentientSettings: { findUnique: vi.fn(), deleteMany: vi.fn() },
  },
}));

const mockDb = db as unknown as {
  session: { findFirst: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  sentientSettings: { findUnique: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
};
const webhook = authenticate.webhook as unknown as ReturnType<typeof vi.fn>;

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
  vi.spyOn(console, 'log').mockImplementation(() => {});
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
