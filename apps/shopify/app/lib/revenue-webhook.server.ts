// Shared action body for the three revenue webhook routes (orders/paid,
// refunds/create, orders/cancelled). They were verbatim-identical before this
// existed, and the drop-visibility work (SHOP-3) plus decrypt-failure handling
// (SHOP-12) would have meant keeping three copies of subtle logic in sync.
// The routes keep their topic-specific contracts in their own comments; this
// owns everything after authenticate.webhook has verified the HMAC.
import { forwardWebhook } from './forward';
import {
  getSettings,
  recordForwardSuccess,
  recordTerminalDrop,
  sentientApiUrl,
  type ShopSettings,
} from './settings.server';

export async function handleRevenueWebhook(
  shop: string,
  topic: string,
  payload: unknown,
): Promise<Response> {
  let settings: ShopSettings | null;
  try {
    settings = await getSettings(shop);
  } catch (err) {
    // decryptSecret throws only when the stored sk_ IS enveloped but the key
    // can't open it — SETTINGS_ENCRYPTION_KEY missing or rotated on the app
    // server. That used to surface as a generic 500 storm with no cause in
    // the logs. Name the real problem once per delivery, but still answer
    // 500: Shopify retrying for 48h is CORRECT here — the data is fine, the
    // operator just has to restore the key, and acking would drop revenue.
    console.error(
      `[sentient] cannot decrypt stored settings for ${shop} (${topic}): ` +
        `SETTINGS_ENCRYPTION_KEY is missing or was rotated on the app server — ` +
        `restore it (deploy runbook) or have the merchant re-save their keys. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
    return new Response(null, { status: 500 });
  }

  const { status, outcome } = await forwardWebhook({
    topic,
    payload,
    secretKey: settings?.secretKey ?? null,
    apiUrl: sentientApiUrl(),
    // Abandoned deliveries must not be silent. The log line is for the
    // operator; recordTerminalDrop is for the MERCHANT — it feeds the
    // settings-screen banner, because Fly logs were the only record that a
    // shop's orders stopped reaching SentientUI (rotated key, unknown order).
    onTerminal: async (info) => {
      const reason = `${info.status} ${info.path} ${info.body}`;
      console.error(`[sentient] dropped ${topic} for ${shop}: ${reason}`);
      await recordTerminalDrop(shop, reason);
    },
  });

  // A successful forward is the banner's all-clear signal. Throttled inside
  // recordForwardSuccess — no DB write per webhook on a busy shop.
  if (outcome === 'forwarded' && settings) {
    await recordForwardSuccess(shop, settings);
  }

  return new Response(null, { status });
}
