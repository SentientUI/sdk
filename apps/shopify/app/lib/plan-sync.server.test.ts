import { afterEach, describe, expect, it, vi } from 'vitest';
import { planFromSubscription, syncPlan } from './plan-sync.server';

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
  it('POSTs the plan with the sk_ bearer and the connector secret header', async () => {
    process.env.SHOPIFY_CONNECTOR_SECRET = 'shared';
    process.env.SENTIENT_API_URL = 'https://api.test';
    const f = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    expect(await syncPlan('sk_test', 'growth', 'x.myshopify.com', f)).toBe(true);
    const [url, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/provision/shopify/plan');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk_test');
    expect(headers['x-connector-secret']).toBe('shared');
    expect(JSON.parse(String(init.body))).toEqual({ plan: 'growth', shopDomain: 'x.myshopify.com' });
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

  it('a non-2xx or unreachable API returns false so the webhook 500s and Shopify retries', async () => {
    process.env.SHOPIFY_CONNECTOR_SECRET = 'shared';
    const bad = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;
    expect(await syncPlan('sk_test', 'growth', 'x.myshopify.com', bad)).toBe(false);
    const boom = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await syncPlan('sk_test', 'growth', 'x.myshopify.com', boom)).toBe(false);
  });

  it('a missing connector secret acks (returns true) — retrying cannot help until the operator sets it', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    expect(await syncPlan('sk_test', 'growth', 'x.myshopify.com', f)).toBe(true);
    expect((f as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
