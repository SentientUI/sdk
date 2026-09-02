import { describe, expect, it } from 'vitest';
import { orderPaidToConversion, refundCreateToRefund } from './sentient';

describe('orderPaidToConversion', () => {
  it('maps the order id, total, currency and attribution tokens', () => {
    expect(orderPaidToConversion({
      id: 5551042,
      total_price: '131.50',
      currency: 'USD',
      processed_at: '2026-08-20T10:00:00Z',
      cart_token: 'cart-tok-1',
      checkout_token: 'chk-tok-1',
    })).toEqual({
      externalId: '5551042',
      value: 131.5,
      currency: 'USD',
      goalName: 'purchase',
      occurredAt: '2026-08-20T10:00:00.000Z',
      attribution: { cartToken: 'cart-tok-1', checkoutToken: 'chk-tok-1' },
    });
  });

  it('normalizes offset timestamps to UTC — the API rejects non-Z datetimes (found live)', () => {
    const req = orderPaidToConversion({
      id: 2, total_price: '32.95', currency: 'USD', processed_at: '2026-08-29T19:52:11-04:00',
    });
    expect(req.occurredAt).toBe('2026-08-29T23:52:11.000Z');
  });

  it('tolerates missing and unparseable timestamps and missing tokens', () => {
    const req = orderPaidToConversion({ id: 1, total_price: 10, currency: 'EUR' });
    expect(req.occurredAt).toBeUndefined();
    expect(req.attribution).toEqual({ cartToken: undefined, checkoutToken: undefined });
    expect(orderPaidToConversion({ id: 1, total_price: 10, currency: 'EUR', processed_at: 'garbage' }).occurredAt).toBeUndefined();
  });
});

describe('refundCreateToRefund', () => {
  it('sums the refund transactions and keys retries on the Shopify refund id', () => {
    expect(refundCreateToRefund({
      id: 900001,
      order_id: 5551042,
      transactions: [{ amount: '30.00' }, { amount: '20.00' }],
    })).toEqual({
      externalId: '5551042',
      amount: 50,
      goalName: 'purchase',
      refundId: '900001',
    });
  });

  it('reports a zero amount when no money moved through a gateway', () => {
    // Shopify sends an empty transaction list for store-credit and gift-card
    // refunds. This used to omit the amount, which the API reads as "refund the
    // full remaining balance" — a £5 store credit wiped the whole order.
    expect(refundCreateToRefund({ id: 1, order_id: 2 }).amount).toBe(0);
    expect(refundCreateToRefund({ id: 1, order_id: 2, transactions: [] }).amount).toBe(0);
    expect(refundCreateToRefund({ id: 1, order_id: 2, transactions: [{ amount: 0 }] }).amount).toBe(0);
  });
});
