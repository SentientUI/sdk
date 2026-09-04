import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate } from '../shopify.server';
import { action as dataRequestAction } from './webhooks.customers.data_request';
import { action as customersRedactAction } from './webhooks.customers.redact';

// GDPR compliance webhooks — mandatory for every App Store listing and probed
// automatically during review. The app stores no customer-identifiable data,
// so the whole obligation is to acknowledge with a 200 after the HMAC check;
// a throw here (401/500) reads as a failed compliance endpoint and blocks
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
