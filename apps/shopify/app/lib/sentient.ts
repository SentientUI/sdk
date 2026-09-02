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

export type ShopifyOrderCancelled = {
  id: number | string;
  total_price?: string | number | null;
  currency?: string | null;
  cancelled_at?: string | null;
};

export type ShopifyRefundCreate = {
  id: number | string;
  order_id: number | string;
  transactions?: Array<{ amount?: string | number | null; currency?: string | null }> | null;
};

/** orders/paid → POST /v1/conversions body. `processed_at` arrives with a
 *  timezone OFFSET (e.g. 2026-08-29T19:52:11-04:00), which the API's
 *  z.string().datetime() rejects — normalize to UTC Z-form; an unparseable
 *  date degrades to "now" server-side rather than failing the whole order.
 *  (Found live: the first dev-store order 400'd on exactly this.) */
export function orderPaidToConversion(order: ShopifyOrderPaid): ConversionRequest {
  const occurredMs = order.processed_at ? Date.parse(order.processed_at) : NaN;
  return {
    externalId: String(order.id),
    value: Number(order.total_price),
    currency: order.currency,
    goalName: 'purchase',
    occurredAt: Number.isFinite(occurredMs) ? new Date(occurredMs).toISOString() : undefined,
    attribution: {
      cartToken: order.cart_token ?? undefined,
      checkoutToken: order.checkout_token ?? undefined,
    },
  };
}

/** refunds/create → POST /v1/refund body. Shopify's refund id is the stable
 *  retry key; the amount is the sum of the refund's gateway transactions.
 *
 *  ALWAYS an explicit number, never undefined. Omitting the amount tells the API
 *  to net the full remaining balance, and Shopify sends an empty `transactions`
 *  list for every refund that does not move money through a gateway — store
 *  credit, gift cards, a return processed with no monetary refund. Those used to
 *  map to "refund everything": a £5 store credit on a £200 order zeroed that
 *  order's revenue and clawed back the optimizer credit for the whole £200.
 *  No transactions means no money moved; under-netting is recoverable, wiping a
 *  real order's revenue is not. */
export function refundCreateToRefund(refund: ShopifyRefundCreate): RefundRequest {
  const txns = refund.transactions ?? [];
  const sum = txns.reduce((s, t) => s + Number(t.amount || 0), 0);
  // Carry the currency the refund actually settled in. RefundRequest declared it
  // and the API accepts it, but nothing populated it — so on a multi-currency
  // store a refund settled in a different presentment currency than the order
  // netted against it silently, with no way for the server to notice.
  const currency = txns.find((t) => typeof t.currency === 'string' && /^[A-Z]{3}$/.test(t.currency))?.currency;
  return {
    externalId: String(refund.order_id),
    amount: Number.isFinite(sum) && sum > 0 ? sum : 0,
    ...(currency ? { currency } : {}),
    goalName: 'purchase',
    refundId: String(refund.id),
  };
}

/** orders/cancelled → POST /v1/refund body.
 *
 *  A cancelled order is not revenue, but nothing was subscribed to this topic,
 *  so a cancellation left the order's full value credited to the optimizer
 *  forever — the merchant's dashboard kept counting a sale that never happened.
 *  Cancelling does not always issue a refund (an unpaid or manually-cancelled
 *  order fires no refunds/create at all), so this cannot be left to that path.
 *
 *  The refundId is namespaced so a cancellation and a later real refund are
 *  distinct retry keys. Double-netting is harmless either way: the API clamps
 *  every refund to the remaining balance, so whichever lands second nets 0.
 */
export function orderCancelledToRefund(order: ShopifyOrderCancelled): RefundRequest {
  const amount = Number(order.total_price ?? 0);
  return {
    externalId: String(order.id),
    amount: Number.isFinite(amount) && amount > 0 ? amount : 0,
    ...(order.currency && /^[A-Z]{3}$/.test(order.currency) ? { currency: order.currency } : {}),
    goalName: 'purchase',
    refundId: `cancel:${order.id}`,
  };
}

/**
 * Shape checks at the webhook boundary.
 *
 * The mappers were handed `payload as ShopifyOrderPaid` — an unchecked cast —
 * and then did `Number(order.total_price)` unconditionally. A renamed or
 * missing field in a newer payload version therefore produced `NaN`, which
 * `JSON.stringify` emits as `null`, which the API rejects as a 400. Before the
 * retry-contract fix that was 48h of retries; now it is a terminal drop. Either
 * way the CAUSE was invisible. Validating here turns "revenue silently stopped
 * arriving" into a named error naming the field.
 *
 * Deliberately hand-rolled: this app has no schema library, and adding one for
 * three object shapes is not worth the dependency in a service that holds
 * merchant secrets.
 */
export type PayloadProblem = { field: string; reason: string };

function idish(v: unknown): boolean {
  return (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isFinite(v));
}

export function validateOrderPaid(p: unknown): PayloadProblem | null {
  if (typeof p !== 'object' || p === null) return { field: '(root)', reason: 'not an object' };
  const o = p as Record<string, unknown>;
  if (!idish(o.id)) return { field: 'id', reason: 'missing or not an id' };
  const total = Number(o.total_price);
  if (o.total_price == null || !Number.isFinite(total)) {
    return { field: 'total_price', reason: `not a number (${String(o.total_price)})` };
  }
  if (typeof o.currency !== 'string' || !/^[A-Z]{3}$/.test(o.currency)) {
    return { field: 'currency', reason: `not an ISO-4217 code (${String(o.currency)})` };
  }
  return null;
}

export function validateRefundCreate(p: unknown): PayloadProblem | null {
  if (typeof p !== 'object' || p === null) return { field: '(root)', reason: 'not an object' };
  const o = p as Record<string, unknown>;
  if (!idish(o.id)) return { field: 'id', reason: 'missing or not an id' };
  if (!idish(o.order_id)) return { field: 'order_id', reason: 'missing or not an id' };
  return null;
}

export function validateOrderCancelled(p: unknown): PayloadProblem | null {
  if (typeof p !== 'object' || p === null) return { field: '(root)', reason: 'not an object' };
  const o = p as Record<string, unknown>;
  if (!idish(o.id)) return { field: 'id', reason: 'missing or not an id' };
  return null;
}
