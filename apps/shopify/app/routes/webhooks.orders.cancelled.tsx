import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { handleRevenueWebhook } from "../lib/revenue-webhook.server";

// orders/cancelled → POST /v1/refund. A cancelled order is not revenue, and
// cancelling does not always issue a refund (an unpaid or manually-cancelled
// order fires no refunds/create at all), so without this the order's full value
// stayed credited to the optimizer and kept showing on the merchant's dashboard
// as a sale that never happened. Retry semantics and drop recording via
// handleRevenueWebhook.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  return handleRevenueWebhook(shop, topic, payload);
};
