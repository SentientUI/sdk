import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSettings, sentientApiUrl } from "../lib/settings.server";
import { forwardWebhook } from "../lib/forward";

// orders/cancelled → POST /v1/refund. A cancelled order is not revenue, and
// cancelling does not always issue a refund (an unpaid or manually-cancelled
// order fires no refunds/create at all), so without this the order's full value
// stayed credited to the optimizer and kept showing on the merchant's dashboard
// as a sale that never happened.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const settings = await getSettings(shop);
  const { status } = await forwardWebhook({
    topic,
    payload,
    secretKey: settings?.secretKey ?? null,
    apiUrl: sentientApiUrl(),
    onTerminal: (info) =>
      console.error(`[sentient] dropped ${topic} for ${shop}: ${info.status} ${info.path} ${info.body}`),
  });
  return new Response(null, { status });
};
