import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { handleRevenueWebhook } from "../lib/revenue-webhook.server";

// refunds/create → POST /v1/refund (README step 3). Same shape as orders/paid:
// HMAC via authenticate.webhook; retry semantics and drop recording via
// handleRevenueWebhook.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  return handleRevenueWebhook(shop, topic, payload);
};
