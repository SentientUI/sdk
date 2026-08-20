// Pure Shopify-webhook → SentientUI-request mappers (spec §3/§6). The app
// backend's HMAC-verified webhook handlers call these and POST the result to
// the SentientUI API with the shop's stored sk_ (`authorization: Bearer sk_…`);
// a non-2xx from SentientUI → the handler responds 500 so Shopify retries
// (48h), mirroring the endpoints' own retry contract. The shop never holds our
// keys client-side — the app backend maps shop-domain → keys.

export type ConversionRequest = {
  externalId: string;
  value: number;
  currency: string;
  goalName: string;
  occurredAt?: string;
  attribution?: { cartToken?: string; checkoutToken?: string; sessionId?: string };
};

export type RefundRequest = {
  externalId: string;
  amount?: number;
  currency?: string;
  goalName: string;
  refundId?: string;
};

export type ShopifyOrderPaid = {
  id: number | string;
  total_price: string | number;
  currency: string;
  processed_at?: string | null;
  cart_token?: string | null;
  checkout_token?: string | null;
};

export type ShopifyRefundCreate = {
  id: number | string;
  order_id: number | string;
  transactions?: Array<{ amount?: string | number | null }> | null;
};

/** orders/paid → POST /v1/conversions body. */
export function orderPaidToConversion(order: ShopifyOrderPaid): ConversionRequest {
  return {
    externalId: String(order.id),
    value: Number(order.total_price),
    currency: order.currency,
    goalName: 'purchase',
    occurredAt: order.processed_at ?? undefined,
    attribution: {
      cartToken: order.cart_token ?? undefined,
      checkoutToken: order.checkout_token ?? undefined,
    },
  };
}

/** refunds/create → POST /v1/refund body. Shopify's refund id is the stable
 *  retry key; the amount is the sum of the refund's transactions (undefined →
 *  the API defaults to the full remaining balance). */
export function refundCreateToRefund(refund: ShopifyRefundCreate): RefundRequest {
  const amount = refund.transactions?.reduce((s, t) => s + Number(t.amount || 0), 0) || undefined;
  return {
    externalId: String(refund.order_id),
    amount,
    goalName: 'purchase',
    refundId: String(refund.id),
  };
}
