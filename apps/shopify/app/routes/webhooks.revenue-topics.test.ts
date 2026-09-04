import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate } from '../shopify.server';
import { handleRevenueWebhook } from '../lib/revenue-webhook.server';
import { action as ordersPaidAction } from './webhooks.orders.paid';
import { action as refundsCreateAction } from './webhooks.refunds.create';
import { action as ordersCancelledAction } from './webhooks.orders.cancelled';

// The three revenue routes are one-liners, which is exactly why they need a
// test: a swapped import or a copy-paste of the wrong handler between paid and
// cancelled would flip a sale into a refund with nothing failing. Pin that
// each route hands the HMAC-verified (shop, topic, payload) to the SHARED
// revenue handler untouched, and answers with whatever it decides — the retry
// contract lives in handleRevenueWebhook, not in the routes.

vi.mock('../shopify.server', () => ({
  authenticate: { webhook: vi.fn() },
}));
vi.mock('../lib/revenue-webhook.server', () => ({
  handleRevenueWebhook: vi.fn(),
}));

const webhook = authenticate.webhook as unknown as ReturnType<typeof vi.fn>;
const handler = handleRevenueWebhook as unknown as ReturnType<typeof vi.fn>;

const CASES = [
  // topic is what Shopify delivers for the subscription the route file's name
  // binds it to; forward.ts maps ORDERS_PAID → /v1/conversions (revenue in)
  // and REFUNDS_CREATE / ORDERS_CANCELLED → /v1/refund (revenue out).
  { name: 'webhooks.orders.paid', action: ordersPaidAction, topic: 'ORDERS_PAID', payload: { id: 987, total_price: '42.50' } },
  { name: 'webhooks.refunds.create', action: refundsCreateAction, topic: 'REFUNDS_CREATE', payload: { id: 555, order_id: 987 } },
  { name: 'webhooks.orders.cancelled', action: ordersCancelledAction, topic: 'ORDERS_CANCELLED', payload: { id: 987, cancelled_at: 'now' } },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(CASES)('$name', ({ action, topic, payload }) => {
  it(`delegates ${topic} to handleRevenueWebhook verbatim and returns its response`, async () => {
    webhook.mockResolvedValue({ shop: 'x.myshopify.com', topic, payload });
    const expected = new Response(null, { status: 500 }); // a distinctive status proves pass-through
    handler.mockResolvedValue(expected);

    const res = await action({
      request: new Request('https://app.test/webhooks', { method: 'POST' }),
      params: {},
      context: {},
    } as never);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('x.myshopify.com', topic, payload);
    expect(res).toBe(expected);
  });
});
