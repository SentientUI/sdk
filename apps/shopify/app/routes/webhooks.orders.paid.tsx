import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSettings, sentientApiUrl } from "../lib/settings.server";
import { forwardWebhook } from "../lib/forward";

// orders/paid → POST /v1/conversions (README step 3). authenticate.webhook
// does the HMAC verification; forwardWebhook owns the retry contract (a
// non-2xx from SentientUI → 500 here → Shopify retries for 48h).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const settings = await getSettings(shop);
  const { status } = await forwardWebhook({
    topic,
    payload,
    secretKey: settings?.secretKey ?? null,
    apiUrl: sentientApiUrl(),
    // Abandoned deliveries must not be silent: this is the only record that a
    // shop's orders stopped reaching SentientUI (rotated key, unknown order).
    onTerminal: (info) =>
      console.error(`[sentient] dropped ${topic} for ${shop}: ${info.status} ${info.path} ${info.body}`),
  });
  return new Response(null, { status });
};
