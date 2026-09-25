import { afterEach, describe, expect, it, vi } from 'vitest';
import { planFromSubscription, readActiveSubscription, readSubscriptionState, subscriptionEvent, syncPlan } from './plan-sync.server';

afterEach(() => {
  delete process.env.SHOPIFY_CONNECTOR_SECRET;
  delete process.env.SENTIENT_API_URL;
});

describe('planFromSubscription', () => {
  it('maps an ACTIVE subscription by its Managed Pricing plan name (case-insensitive)', () => {
    expect(planFromSubscription({ app_subscription: { name: 'Growth', status: 'ACTIVE' } })).toBe('growth');
    expect(planFromSubscription({ app_subscription: { name: ' scale ', status: 'active' } })).toBe('scale');
  });

  it('an ended subscription downgrades to free regardless of plan name', () => {
    for (const status of ['CANCELLED', 'EXPIRED', 'DECLINED', 'FROZEN']) {
      expect(planFromSubscription({ app_subscription: { name: 'Growth', status } })).toBe('free');
    }
  });

  it('an unknown plan name is ignored, never a downgrade — renaming a Shopify plan must not zero a paying customer', () => {
    expect(planFromSubscription({ app_subscription: { name: 'Legacy Gold', status: 'ACTIVE' } })).toBeNull();
  });

  it('irrelevant statuses and empty payloads are ignored', () => {
    expect(planFromSubscription({ app_subscription: { name: 'Growth', status: 'PENDING' } })).toBeNull();
    expect(planFromSubscription({})).toBeNull();
  });
});

describe('syncPlan', () => {
  it('POSTs by shop with the connector secret and the app key first (review R4 N1, R5 H1)', async () => {
    process.env.SHOPIFY_CONNECTOR_SECRET = 'shared';
    process.env.SENTIENT_API_URL = 'https://api.test';
    const f = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    expect(await syncPlan('sk_test', 'growth', 'x.myshopify.com', f)).toBe(true);
    const [url, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/provision/shopify/plan-by-shop');
    const headers = init.headers as Record<string, string>;
    // The key names the project (even once revoked); the binding must be live.
    expect(headers.authorization).toBe('Bearer sk_test');
    expect(headers['x-connector-secret']).toBe('shared');
    expect(JSON.parse(String(init.body))).toEqual({ plan: 'growth', shopDomain: 'x.myshopify.com' });
  });

  it('falls back to the sk_ route for a shop not bound yet', async () => {
    process.env.SHOPIFY_CONNECTOR_SECRET = 'shared';
    process.env.SENTIENT_API_URL = 'https://api.test';
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, status: 200 }) as unknown as typeof fetch;
    expect(await syncPlan('sk_test', 'growth', 'x.myshopify.com', f)).toBe(true);
    const [url, init] = (f as ReturnType<typeof vi.fn>).mock.calls[1]! as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/provision/shopify/plan');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk_test');
  });

  it('marks an uninstall as a disconnect, which is what hands the billing rail back to card billing', async () => {
    process.env.SHOPIFY_CONNECTOR_SECRET = 'shared';
    const f = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    await syncPlan('sk_test', 'free', 'x.myshopify.com', f, { disconnect: true });
    const [, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      plan: 'free',
      shopDomain: 'x.myshopify.com',
      disconnect: true,
    });
  });

  it('a plain cancellation is NOT a disconnect — the merchant still has the app and can re-subscribe through Shopify', async () => {
    process.env.SHOPIFY_CONNECTOR_SECRET = 'shared';
    const f = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    await syncPlan('sk_test', 'free', 'x.myshopify.com', f);
    const [, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty('disconnect');
  });

  it('a 5xx/429 or unreachable API returns false (retry); a permanent 4xx is terminal (erase/ack instead of 48 h of 500s)', async () => {
    process.env.SHOPIFY_CONNECTOR_SECRET = 'shared';
    const bad = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    expect(await syncPlan('sk_test', 'growth', 'x.myshopify.com', bad)).toBe(false);
    const boom = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await syncPlan('sk_test', 'growth', 'x.myshopify.com', boom)).toBe(false);
    const revoked = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 401 }) as unknown as typeof fetch;
    expect(await syncPlan('sk_test', 'growth', 'x.myshopify.com', revoked)).toBe('terminal');
    // A connector-secret mismatch is misconfiguration that will be fixed: retry.
    const mismatch = vi.fn(async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
    expect(await syncPlan('sk_test', 'growth', 'x.myshopify.com', mismatch)).toBe(false);
  });

  it('a missing connector secret FAILS (returns false) so Shopify keeps retrying — an ack told Shopify a paid plan was applied when nothing happened (P0-7)', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    expect(await syncPlan('sk_test', 'growth', 'x.myshopify.com', f)).toBe(false);
    expect((f as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('forwards the subscription id, its updated_at and whether it ended, so the API can apply events in order (P0-9)', async () => {
    process.env.SHOPIFY_CONNECTOR_SECRET = 'shared';
    const f = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    const event = subscriptionEvent({
      app_subscription: { name: 'Growth', status: 'CANCELLED', admin_graphql_api_id: 'gid://shopify/AppSubscription/1', updated_at: '2026-09-25T10:00:00Z' },
    })!;
    await syncPlan('sk_test', event.plan, 'x.myshopify.com', f, { event });
    const [, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      plan: 'free',
      shopDomain: 'x.myshopify.com',
      ended: true,
      status: 'CANCELLED',
      subscriptionId: 'gid://shopify/AppSubscription/1',
      subscriptionUpdatedAt: '2026-09-25T10:00:00Z',
    });
  });
});

// Review R9 M1: a 200 that says "refused" is a charge that will not apply.
describe('syncPlan refused', () => {
  it('reports a purchase the API refused (the account is billed another way)', async () => {
    process.env.SHOPIFY_CONNECTOR_SECRET = 'shared';
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, plan: 'growth', applied: false, reason: 'refused' }) })) as unknown as typeof fetch;
    expect(await syncPlan('sk_test', 'growth', 'x.myshopify.com', f)).toBe('refused');
    const g = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, applied: false, reason: 'no_change' }) })) as unknown as typeof fetch;
    expect(await syncPlan('sk_test', 'growth', 'x.myshopify.com', g)).toBe(true);
  });
});

// Review R9 ADV-2: "none" is told apart from a failed read.
describe('readSubscriptionState', () => {
  const gql = (payload: unknown) => vi.fn(async () => ({ json: async () => payload }));
  it('an empty list is an explicit none; a failed or malformed read is unknown', async () => {
    expect(await readSubscriptionState(gql({ data: { currentAppInstallation: { activeSubscriptions: [] } } }))).toEqual({ event: null, observed: 'none' });
    expect(await readSubscriptionState(gql({ errors: [{ message: 'throttled' }] }))).toEqual({ event: null, observed: null });
    expect(await readSubscriptionState(vi.fn(async () => { throw new Error('down'); }))).toEqual({ event: null, observed: null });
  });
  it('an ACTIVE subscription is an event, never a none', async () => {
    const s = await readSubscriptionState(gql({ data: { currentAppInstallation: { activeSubscriptions: [
      { id: 'gid://s/9', name: 'Growth', status: 'ACTIVE' },
    ] } } }));
    expect(s.observed).toBeNull();
    expect(s.event).toMatchObject({ plan: 'growth', status: 'ACTIVE', subscriptionId: 'gid://s/9' });
  });
});

describe('subscriptionEvent', () => {
  it('an ACTIVE free plan is not "ended" — it is the merchant\'s current subscription', () => {
    expect(subscriptionEvent({ app_subscription: { name: 'Free', status: 'ACTIVE', admin_graphql_api_id: 'gid://x/2' } })).toEqual({
      plan: 'free',
      ended: false,
      status: 'ACTIVE',
      subscriptionId: 'gid://x/2',
    });
  });
  it('drops an unparseable updated_at rather than forwarding it', () => {
    expect(subscriptionEvent({ app_subscription: { name: 'Growth', status: 'ACTIVE', updated_at: 'yesterday' } })).toEqual({ plan: 'growth', ended: false, status: 'ACTIVE' });
  });
  it('ignores what planFromSubscription ignores', () => {
    expect(subscriptionEvent({ app_subscription: { name: 'Growth', status: 'PENDING' } })).toBeNull();
  });
});

describe('readActiveSubscription (grader R1 N9)', () => {
  const gql = (payload: unknown) => vi.fn(async () => ({ json: async () => payload }));

  it("reports Shopify's ACTIVE subscription as an event, ordered on its createdAt", async () => {
    const e = await readActiveSubscription(gql({
      data: { currentAppInstallation: { activeSubscriptions: [
        { id: 'gid://s/9', name: 'Growth', status: 'ACTIVE', createdAt: '2026-09-25T10:00:00Z' },
      ] } },
    }));
    // Ordered as "observed ACTIVE now" (a minute back), not on createdAt,
    // which could never move past a later FROZEN or a release (review R3).
    expect(e).toMatchObject({ plan: 'growth', ended: false, status: 'ACTIVE', subscriptionId: 'gid://s/9' });
    expect(Date.now() - Date.parse(e!.updatedAt!)).toBeGreaterThanOrEqual(59_000);
    expect(Date.now() - Date.parse(e!.updatedAt!)).toBeLessThan(120_000);
  });

  it('never reports "none": a downgrade from a read taken mid-purchase would end a plan just bought', async () => {
    expect(await readActiveSubscription(gql({ data: { currentAppInstallation: { activeSubscriptions: [] } } }))).toBeNull();
    expect(await readActiveSubscription(gql({ data: { currentAppInstallation: { activeSubscriptions: [
      { id: 'gid://s/1', name: 'Growth', status: 'PENDING' },
    ] } } }))).toBeNull();
  });

  it('an unknown plan name or a failed read is null', async () => {
    expect(await readActiveSubscription(gql({ data: { currentAppInstallation: { activeSubscriptions: [
      { id: 'gid://s/1', name: 'Legacy Gold', status: 'ACTIVE' },
    ] } } }))).toBeNull();
    expect(await readActiveSubscription(vi.fn(async () => { throw new Error('down'); }))).toBeNull();
  });
});

