import { describe, expect, it, vi } from 'vitest';
import { forwardWebhook } from './forward';

const ORDER = { id: 987, total_price: '42.50', currency: 'EUR', cart_token: 'ct1' };
const REFUND = { id: 555, order_id: 987, transactions: [{ amount: '10.00' }] };

function fetchOk(status = 200) {
  return vi.fn(async () => ({ ok: status < 400, status })) as unknown as typeof fetch;
}

describe('forwardWebhook — the retry contract', () => {
  it('orders/paid maps to /v1/conversions with the shop sk_', async () => {
    const f = fetchOk();
    const r = await forwardWebhook({ topic: 'ORDERS_PAID', payload: ORDER, secretKey: 'sk_test', apiUrl: 'https://api.test', fetchImpl: f });
    expect(r.status).toBe(200);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/conversions');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer sk_test' });
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toMatchObject({ externalId: '987', value: 42.5, currency: 'EUR', goalName: 'purchase' });
  });

  it('refunds/create maps to /v1/refund with the refund id as the retry key', async () => {
    const f = fetchOk();
    const r = await forwardWebhook({ topic: 'REFUNDS_CREATE', payload: REFUND, secretKey: 'sk_test', apiUrl: 'https://api.test', fetchImpl: f });
    expect(r.status).toBe(200);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/refund');
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({ externalId: '987', refundId: '555', amount: 10 });
  });

  it('a non-2xx from SentientUI → 500, so Shopify retries for 48h', async () => {
    const r = await forwardWebhook({ topic: 'ORDERS_PAID', payload: ORDER, secretKey: 'sk_test', apiUrl: 'https://api.test', fetchImpl: fetchOk(503) });
    expect(r.status).toBe(500);
  });

  it('an unreachable API → 500 (same retry path)', async () => {
    const boom = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const r = await forwardWebhook({ topic: 'ORDERS_PAID', payload: ORDER, secretKey: 'sk_test', fetchImpl: boom });
    expect(r.status).toBe(500);
  });

  it('no stored keys → 200 and no call — retrying an unconfigured shop is 48h of noise', async () => {
    const f = fetchOk();
    const r = await forwardWebhook({ topic: 'ORDERS_PAID', payload: ORDER, secretKey: null, fetchImpl: f });
    expect(r.status).toBe(200);
    expect(f).not.toHaveBeenCalled();
  });

  it('an unknown topic → 200 and no call (nothing to forward)', async () => {
    const f = fetchOk();
    const r = await forwardWebhook({ topic: 'PRODUCTS_UPDATE', payload: {}, secretKey: 'sk_test', fetchImpl: f });
    expect(r.status).toBe(200);
    expect(f).not.toHaveBeenCalled();
  });

  // A 4xx is the API saying "this request is wrong", not "try again later".
  // Answering 500 bought 48h of retries that could never succeed: a rotated
  // sk_ (401), a refund for a pre-install order (404), a free order (400).
  it.each([400, 401, 403, 404, 422])('a terminal %i → 200, and reports the drop', async (status) => {
    const onTerminal = vi.fn();
    const r = await forwardWebhook({
      topic: 'ORDERS_PAID', payload: ORDER, secretKey: 'sk_test',
      fetchImpl: fetchOk(status), onTerminal,
    });
    expect(r.status).toBe(200);
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status, path: '/v1/conversions' }));
  });

  it.each([408, 429, 500, 502, 503])('a transient %i → 500, keeping the retry', async (status) => {
    const onTerminal = vi.fn();
    const r = await forwardWebhook({
      topic: 'ORDERS_PAID', payload: ORDER, secretKey: 'sk_test',
      fetchImpl: fetchOk(status), onTerminal,
    });
    expect(r.status).toBe(500);
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it('a refund with no gateway transactions → 200 and no call', async () => {
    // Store credit and gift-card refunds carry no transactions. Forwarding
    // those without an amount made the API net the FULL remaining balance.
    const f = fetchOk();
    const r = await forwardWebhook({
      topic: 'REFUNDS_CREATE', payload: { id: 1, order_id: 987, transactions: [] },
      secretKey: 'sk_test', fetchImpl: f,
    });
    expect(r.status).toBe(200);
    expect(f).not.toHaveBeenCalled();
  });

  it('a real refund still forwards its summed amount', async () => {
    const f = fetchOk();
    await forwardWebhook({
      topic: 'REFUNDS_CREATE',
      payload: { id: 1, order_id: 987, transactions: [{ amount: '10.00' }, { amount: '5.50' }] },
      secretKey: 'sk_test', fetchImpl: f,
    });
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({ externalId: '987', amount: 15.5 });
  });
});

describe('cancelled orders', () => {
  // Nothing was subscribed to orders/cancelled, and cancelling does not always
  // issue a refund — so a cancelled order kept its full value credited to the
  // optimizer and kept showing on the merchant's dashboard as a real sale.
  it('nets a cancelled order against its recorded revenue', async () => {
    const f = fetchOk();
    const r = await forwardWebhook({
      topic: 'ORDERS_CANCELLED',
      payload: { id: 987, total_price: '42.50', currency: 'EUR', cancelled_at: '2026-08-30T10:00:00Z' },
      secretKey: 'sk_test', apiUrl: 'https://api.test', fetchImpl: f,
    });
    expect(r.status).toBe(200);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/refund');
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({
      externalId: '987',
      amount: 42.5,
      currency: 'EUR',
      // Namespaced so a cancellation and a later real refund stay distinct
      // retry keys; the API clamps both to the remaining balance anyway.
      refundId: 'cancel:987',
    });
  });

  it('does not forward a cancelled order that carried no value', async () => {
    const f = fetchOk();
    const r = await forwardWebhook({
      topic: 'ORDERS_CANCELLED', payload: { id: 5, total_price: '0.00' },
      secretKey: 'sk_test', fetchImpl: f,
    });
    expect(r.status).toBe(200);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('payload validation at the webhook boundary', () => {
  // The mappers took `payload as ShopifyOrderPaid` — an unchecked cast — then
  // did Number(total_price) unconditionally. A renamed field in a newer payload
  // version became NaN → null → a 400 with no clue why. The Admin API and the
  // webhook subscription were also two years apart, which is exactly how such a
  // skew arrives.
  it('drops an unusable orders/paid payload terminally, naming the field', async () => {
    const f = fetchOk();
    const onTerminal = vi.fn();
    const r = await forwardWebhook({
      topic: 'ORDERS_PAID',
      payload: { id: 987, currency: 'EUR' }, // total_price renamed away
      secretKey: 'sk_test', fetchImpl: f, onTerminal,
    });
    expect(r.status).toBe(200);
    expect(f).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('total_price') }),
    );
  });

  it('drops an order with a non-ISO currency rather than sending NaN downstream', async () => {
    const onTerminal = vi.fn();
    const r = await forwardWebhook({
      topic: 'ORDERS_PAID',
      payload: { id: 1, total_price: '10.00', currency: 'euros' },
      secretKey: 'sk_test', fetchImpl: fetchOk(), onTerminal,
    });
    expect(r.status).toBe(200);
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('currency') }),
    );
  });

  it('drops a refund with no order_id', async () => {
    const onTerminal = vi.fn();
    const r = await forwardWebhook({
      topic: 'REFUNDS_CREATE', payload: { id: 5, transactions: [{ amount: '3.00' }] },
      secretKey: 'sk_test', fetchImpl: fetchOk(), onTerminal,
    });
    expect(r.status).toBe(200);
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('order_id') }),
    );
  });

  it('still forwards a well-formed payload untouched', async () => {
    const f = fetchOk();
    const r = await forwardWebhook({
      topic: 'ORDERS_PAID', payload: ORDER, secretKey: 'sk_test', fetchImpl: f,
    });
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalled();
  });
});
