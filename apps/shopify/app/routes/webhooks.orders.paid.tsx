import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { handleRevenueWebhook } from "../lib/revenue-webhook.server";

// orders/paid → POST /v1/conversions (README step 3). authenticate.webhook
// does the HMAC verification; handleRevenueWebhook owns the retry contract (a
// non-2xx from SentientUI → 500 here → Shopify retries for 48h) and records
// terminal drops so the settings screen can warn the merchant.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  return handleRevenueWebhook(shop, topic, payload);
};
