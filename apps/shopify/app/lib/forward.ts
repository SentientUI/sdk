// Webhook forwarding core (README step 3), kept pure so the retry contract is
// unit-testable without Remix or Shopify's runtime: map the HMAC-verified
// payload with the sentient.ts mappers and POST it to the SentientUI API with
// the shop's stored sk_. The returned status is what the webhook route answers
// Shopify with, and the semantics matter:
//
//   200 — forwarded, or nothing to forward (no keys configured, unknown topic,
//         zero-value refund), or SentientUI answered with a 4xx that no number
//         of retries can turn into a success. Retrying can't help any of these,
//         so don't invite 48h of it — report it through onTerminal instead.
//   500 — SentientUI was unreachable, or answered 5xx/408/429. Shopify retries
//         for 48h, mirroring the API's own durable-delivery contract.
import {
  orderPaidToConversion,
  refundCreateToRefund,
  orderCancelledToRefund,
  validateOrderPaid,
  validateRefundCreate,
  validateOrderCancelled,
  type ShopifyOrderPaid,
  type ShopifyRefundCreate,
  type ShopifyOrderCancelled,
} from './sentient';

export const SENTIENT_API_DEFAULT = 'https://api.sentient-ui.com';

export type ForwardTopic = 'ORDERS_PAID' | 'REFUNDS_CREATE' | 'ORDERS_CANCELLED';

export async function forwardWebhook(opts: {
  topic: string;
  payload: unknown;
  /** The shop's stored secret key; null → not configured → 200 (drop). */
  secretKey: string | null;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  /** Called when a delivery is abandoned as unretryable, so it isn't silent. */
  onTerminal?: (info: { path: string; status: number; body: string }) => void;
}): Promise<{ status: 200 | 500 }> {
  const { topic, payload, secretKey } = opts;
  if (!secretKey) return { status: 200 };

  let path: string;
  let body: unknown;
  if (topic === 'ORDERS_PAID') {
    path = '/v1/conversions';
    // Validate before mapping. The cast below is unchecked, and the mapper does
    // Number(total_price) unconditionally — so a renamed field in a newer
    // payload version became NaN, then a null, then a 400 with no clue why.
    const bad = validateOrderPaid(payload);
    if (bad) {
      opts.onTerminal?.({ path, status: 0, body: `unusable orders/paid payload: ${bad.field} ${bad.reason}` });
      return { status: 200 }; // retrying the same malformed payload cannot help
    }
    body = orderPaidToConversion(payload as ShopifyOrderPaid);
  } else if (topic === 'REFUNDS_CREATE' || topic === 'ORDERS_CANCELLED') {
    path = '/v1/refund';
    const bad = topic === 'ORDERS_CANCELLED'
      ? validateOrderCancelled(payload)
      : validateRefundCreate(payload);
    if (bad) {
      opts.onTerminal?.({ path, status: 0, body: `unusable ${topic} payload: ${bad.field} ${bad.reason}` });
      return { status: 200 };
    }
    const refund =
      topic === 'ORDERS_CANCELLED'
        ? orderCancelledToRefund(payload as ShopifyOrderCancelled)
        : refundCreateToRefund(payload as ShopifyRefundCreate);
    // No money moved through a gateway, so there is nothing to net — and the
    // API rejects a non-positive amount. Retrying cannot change either fact.
    if (refund.amount == null || refund.amount <= 0) return { status: 200 };
    body = refund;
  } else {
    return { status: 200 }; // unknown topic — nothing to forward
  }

  try {
    const res = await (opts.fetchImpl ?? fetch)(`${opts.apiUrl ?? SENTIENT_API_DEFAULT}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secretKey}` },
      body: JSON.stringify(body),
    });
    if (res.ok) return { status: 200 };
    // A 4xx will never succeed however often Shopify retries it: a revoked or
    // rotated sk_ (401), a refund for an order placed before install (404), a
    // 100%-discount order the schema rejects (400). Answering 500 bought 48h of
    // retries that could not work — the same class of bug as the offset
    // timestamps, which was fixed at the symptom and not here. 408/429 are
    // genuinely transient, so they keep the retry.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      // Body is best-effort diagnostics only — never let reading it turn a
      // terminal drop back into a retry.
      const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
      opts.onTerminal?.({ path, status: res.status, body: text.slice(0, 500) });
      return { status: 200 };
    }
    return { status: 500 };
  } catch {
    return { status: 500 };
  }
}
