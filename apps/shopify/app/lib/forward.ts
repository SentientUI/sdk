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

/** Why the status is what it is. The HTTP status alone conflates "delivered"
 *  with "abandoned" (both 200), so callers recording merchant-visible health
 *  (lastForwardAt vs lastDropAt) need the distinction:
 *    forwarded — SentientUI accepted it.
 *    skipped   — nothing to send (no keys, unknown topic, zero-value refund).
 *    dropped   — terminal: onTerminal fired, revenue data is gone.
 *    retry     — transient: Shopify will redeliver.
 */
export type ForwardOutcome = 'forwarded' | 'skipped' | 'dropped' | 'retry';

export async function forwardWebhook(opts: {
  topic: string;
  payload: unknown;
  /** The shop's stored secret key; null → not configured → 200 (drop). */
  secretKey: string | null;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  /** Called when a delivery is abandoned as unretryable, so it isn't silent.
   *  Awaited: the routes persist the drop from here, and an un-awaited write
   *  could still be in flight when the 200 goes back to Shopify. Must not
   *  throw — a failed record must never turn a terminal drop into a retry. */
  onTerminal?: (info: { path: string; status: number; body: string }) => void | Promise<void>;
}): Promise<{ status: 200 | 500; outcome: ForwardOutcome }> {
  const { topic, payload, secretKey } = opts;
  if (!secretKey) return { status: 200, outcome: 'skipped' };

  let path: string;
  let body: unknown;
  if (topic === 'ORDERS_PAID') {
    path = '/v1/conversions';
    // Validate before mapping. The cast below is unchecked, and the mapper does
    // Number(total_price) unconditionally — so a renamed field in a newer
    // payload version became NaN, then a null, then a 400 with no clue why.
    const bad = validateOrderPaid(payload);
    if (bad) {
      await opts.onTerminal?.({ path, status: 0, body: `unusable orders/paid payload: ${bad.field} ${bad.reason}` });
      return { status: 200, outcome: 'dropped' }; // retrying the same malformed payload cannot help
    }
    body = orderPaidToConversion(payload as ShopifyOrderPaid);
  } else if (topic === 'REFUNDS_CREATE' || topic === 'ORDERS_CANCELLED') {
    path = '/v1/refund';
    const bad = topic === 'ORDERS_CANCELLED'
      ? validateOrderCancelled(payload)
      : validateRefundCreate(payload);
    if (bad) {
      await opts.onTerminal?.({ path, status: 0, body: `unusable ${topic} payload: ${bad.field} ${bad.reason}` });
      return { status: 200, outcome: 'dropped' };
    }
    const refund =
      topic === 'ORDERS_CANCELLED'
        ? orderCancelledToRefund(payload as ShopifyOrderCancelled)
        : refundCreateToRefund(payload as ShopifyRefundCreate);
    // No money moved through a gateway, so there is nothing to net — and the
    // API rejects a non-positive amount. Retrying cannot change either fact.
    if (refund.amount == null || refund.amount <= 0) return { status: 200, outcome: 'skipped' };
    body = refund;
  } else {
    return { status: 200, outcome: 'skipped' }; // unknown topic — nothing to forward
  }

  try {
    const res = await (opts.fetchImpl ?? fetch)(`${opts.apiUrl ?? SENTIENT_API_DEFAULT}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secretKey}` },
      body: JSON.stringify(body),
      // Shopify abandons a webhook delivery at ~5s and counts it against the
      // app's health. An API that HANGS (rather than erroring) used to eat the
      // whole budget and blow that deadline; abort well inside it so the
      // handler always answers. The abort throws, landing in the catch below —
      // a 500, i.e. retryable, which is right: a hung API is transient, the
      // same class as unreachable, never a terminal drop.
      signal: AbortSignal.timeout(3_500),
    });
    if (res.ok) return { status: 200, outcome: 'forwarded' };
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
      await opts.onTerminal?.({ path, status: res.status, body: text.slice(0, 500) });
      return { status: 200, outcome: 'dropped' };
    }
    return { status: 500, outcome: 'retry' };
  } catch {
    // Network failure or the timeout above — both transient, both retryable.
    return { status: 500, outcome: 'retry' };
  }
}
