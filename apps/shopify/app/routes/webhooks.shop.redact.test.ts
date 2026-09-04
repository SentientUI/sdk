import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate } from '../shopify.server';
import db from '../db.server';
import { action } from './webhooks.shop.redact';

// shop/redact fires ~48h AFTER the uninstall — squarely inside the reinstall
// window — so its staleness guard matters even more than app/uninstalled's.
// This handler used to re-implement the check inline against ONLY
// settings.updatedAt (and only when the row still existed): a merchant who had
// reinstalled but not yet re-saved keys had no settings row at all (the first
// uninstall delivery deleted it), so the guard fell through and the redact
// wiped their brand-new session. These tests pin the shared isStaleUninstall
// path with both clocks.

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
  return new Request('https://app.test/webhooks/shop/redact', { method: 'POST', headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  webhook.mockResolvedValue({ shop: 'x.myshopify.com', topic: 'SHOP_REDACT' });
  mockDb.sentientSettings.findUnique.mockResolvedValue(null);
  mockDb.session.findFirst.mockResolvedValue(null);
  mockDb.session.deleteMany.mockResolvedValue({ count: 0 });
  mockDb.sentientSettings.deleteMany.mockResolvedValue({ count: 0 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('webhooks.shop.redact — staleness guard', () => {
  it('a genuinely current redact erases sessions and settings (the GDPR backstop)', async () => {
    mockDb.sentientSettings.findUnique.mockResolvedValue({ updatedAt: BEFORE_EVENT });
    mockDb.session.findFirst.mockResolvedValue({ createdAt: BEFORE_EVENT });
    const res = await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(mockDb.session.deleteMany).toHaveBeenCalledWith({ where: { shop: 'x.myshopify.com' } });
    expect(mockDb.sentientSettings.deleteMany).toHaveBeenCalledWith({ where: { shop: 'x.myshopify.com' } });
  });

  it('a redact for a shop with no rows at all still 200s (normal case: uninstalled wiped already)', async () => {
    const res = await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(mockDb.session.deleteMany).toHaveBeenCalled(); // idempotent deleteMany, count 0
  });

  it('stale (keys re-saved since it fired) → no wipe', async () => {
    mockDb.sentientSettings.findUnique.mockResolvedValue({ updatedAt: AFTER_EVENT });
    const res = await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(mockDb.session.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.sentientSettings.deleteMany).not.toHaveBeenCalled();
  });

  it('stale via the session clock (reinstalled, keys NOT yet re-saved) → no wipe', async () => {
    // THE BUG this file exists for: no settings row (the uninstall delivery
    // deleted it), only a fresh Session row proves the reinstall. The old
    // inline `current.updatedAt` check required the settings row to exist and
    // wiped this merchant's new login mid-setup.
    mockDb.sentientSettings.findUnique.mockResolvedValue(null);
    mockDb.session.findFirst.mockResolvedValue({ createdAt: AFTER_EVENT });
    await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(mockDb.session.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.sentientSettings.deleteMany).not.toHaveBeenCalled();
  });

  it('a missing/unparseable trigger header never skips the erasure', async () => {
    // This is a GDPR obligation: when staleness cannot be proven, erase.
    mockDb.sentientSettings.findUnique.mockResolvedValue({ updatedAt: AFTER_EVENT });
    mockDb.session.findFirst.mockResolvedValue({ createdAt: AFTER_EVENT });
    await action({ request: makeRequest(null), params: {}, context: {} } as never);
    expect(mockDb.session.deleteMany).toHaveBeenCalled();
    expect(mockDb.sentientSettings.deleteMany).toHaveBeenCalled();
  });

  it('reads x-shopify-triggered-at BEFORE authenticate.webhook consumes the request', async () => {
    // Same ordering pin as app/uninstalled: if the header were read after
    // authenticate.webhook, a consumed request would yield NaN and every
    // stale duplicate would erase a live reinstall.
    webhook.mockImplementation(async (request: Request) => {
      request.headers.delete('x-shopify-triggered-at');
      return { shop: 'x.myshopify.com', topic: 'SHOP_REDACT' };
    });
    mockDb.session.findFirst.mockResolvedValue({ createdAt: AFTER_EVENT });
    await action({ request: makeRequest(), params: {}, context: {} } as never);
    expect(mockDb.session.deleteMany).not.toHaveBeenCalled();
  });
});
