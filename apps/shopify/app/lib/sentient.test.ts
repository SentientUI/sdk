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
      occurredAt: '2026-08-20T10:00:00Z',
      attribution: { cartToken: 'cart-tok-1', checkoutToken: 'chk-tok-1' },
    });
  });

  it('tolerates missing timestamps and tokens', () => {
    const req = orderPaidToConversion({ id: 1, total_price: 10, currency: 'EUR' });
    expect(req.occurredAt).toBeUndefined();
    expect(req.attribution).toEqual({ cartToken: undefined, checkoutToken: undefined });
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

  it('omits the amount (→ full remaining) when transactions are absent or zero', () => {
    expect(refundCreateToRefund({ id: 1, order_id: 2 }).amount).toBeUndefined();
    expect(refundCreateToRefund({ id: 1, order_id: 2, transactions: [{ amount: 0 }] }).amount).toBeUndefined();
  });
});
