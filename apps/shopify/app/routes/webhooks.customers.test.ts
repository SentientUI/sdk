import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate } from '../shopify.server';
import { action as dataRequestAction } from './webhooks.customers.data_request';
import { action as customersRedactAction } from './webhooks.customers.redact';

// GDPR compliance webhooks — mandatory for every App Store listing and probed
// automatically during review. The app stores no customer-identifiable data,
// but the API holds forwarded orders by id, so a delivery naming orders is
// forwarded (audit H7); one naming none is acknowledged with a 200. A throw
// on a probe (401/500) reads as a failed compliance endpoint and blocks
// listing. authenticate.webhook rejecting unsigned probes is the library's
// contract — what these tests pin is that OUR handlers never turn a verified
// delivery into anything but a 200, whatever the payload looks like.

vi.mock('../shopify.server', () => ({
  authenticate: { webhook: vi.fn() },
}));

const webhook = authenticate.webhook as unknown as ReturnType<typeof vi.fn>;

const CASES = [
  { name: 'webhooks.customers.data_request', action: dataRequestAction, topic: 'CUSTOMERS_DATA_REQUEST' },
  { name: 'webhooks.customers.redact', action: customersRedactAction, topic: 'CUSTOMERS_REDACT' },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe.each(CASES)('$name', ({ action, topic }) => {
  it('acknowledges a verified delivery with a 200', async () => {
    webhook.mockResolvedValue({
      shop: 'x.myshopify.com',
      topic,
      payload: { shop_id: 1, shop_domain: 'x.myshopify.com', customer: { id: 42 } },
    });
    const res = await action({
      request: new Request('https://app.test/webhooks', { method: 'POST' }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });

  it('still 200s on a malformed payload — the handler must not depend on payload shape', async () => {
    // A reshaped payload in a future API version must not 500 a compliance
    // endpoint into 48h of retries; there is nothing in the payload this app
    // needs in order to meet the obligation.
    webhook.mockResolvedValue({ shop: 'x.myshopify.com', topic, payload: 'not-even-an-object' });
    const res = await action({
      request: new Request('https://app.test/webhooks', { method: 'POST' }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });
});

describe.each([
  { action: customersRedactAction, topic: 'CUSTOMERS_REDACT', key: 'orders_to_redact', mode: 'redact' },
  { action: dataRequestAction, topic: 'CUSTOMERS_DATA_REQUEST', key: 'orders_requested', mode: 'export' },
] as const)('$topic forwards the named orders to the API (audit H7)', ({ action, topic, key, mode }) => {
  const run = () =>
    action({ request: new Request('https://app.test/webhooks', { method: 'POST' }), params: {}, context: {} } as never);

  it('POSTs the order ids with the connector secret and 200s when the API applied it', async () => {
    process.env.SHOPIFY_CONNECTOR_SECRET = 'shared';
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, projects: 1 }) }));
    vi.stubGlobal('fetch', f);
    webhook.mockResolvedValue({ shop: 'x.myshopify.com', topic, payload: { [key]: [299938, '280263', 'junk'] } });
    const res = await run();
    expect(res.status).toBe(200);
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/provision\/shopify\/customer$/);
    expect((init.headers as Record<string, string>)['x-connector-secret']).toBe('shared');
    expect(JSON.parse(String(init.body))).toEqual({ mode, shopDomain: 'x.myshopify.com', orderIds: ['299938', '280263'] });
    vi.unstubAllGlobals();
    delete process.env.SHOPIFY_CONNECTOR_SECRET;
  });

  it('500s when the API did not apply it, so Shopify retries', async () => {
    process.env.SHOPIFY_CONNECTOR_SECRET = 'shared';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    webhook.mockResolvedValue({ shop: 'x.myshopify.com', topic, payload: { [key]: [1] } });
    expect((await run()).status).toBe(500);
    vi.unstubAllGlobals();
    delete process.env.SHOPIFY_CONNECTOR_SECRET;
  });
});

describe('customers/redact — chunking and honesty (grader R1 N4)', () => {
  const run = () =>
    customersRedactAction({ request: new Request('https://app.test/webhooks', { method: 'POST' }), params: {}, context: {} } as never);

  it('splits a large request so the API cap never turns it into a permanent retry loop', async () => {
    process.env.SHOPIFY_CONNECTOR_SECRET = 'shared';
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ projects: 1 }) }));
    vi.stubGlobal('fetch', f);
    webhook.mockResolvedValue({ shop: 'x.myshopify.com', topic: 'CUSTOMERS_REDACT', payload: { orders_to_redact: Array.from({ length: 2500 }, (_, i) => i + 1) } });
    expect((await run()).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
    delete process.env.SHOPIFY_CONNECTOR_SECRET;
  });

  it('says so when no SentientUI project is bound to the shop, instead of claiming a redaction', async () => {
    process.env.SHOPIFY_CONNECTOR_SECRET = 'shared';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ projects: 0 }) })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    webhook.mockResolvedValue({ shop: 'x.myshopify.com', topic: 'CUSTOMERS_REDACT', payload: { orders_to_redact: [1] } });
    expect((await run()).status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('no SentientUI project'))).toBe(true);
    vi.unstubAllGlobals();
    delete process.env.SHOPIFY_CONNECTOR_SECRET;
  });
});

