import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticateWebhookAllowingExpiredToken } from "../lib/webhook-auth.server";
import { clearPlanIssue, getSettings, recordPlanIssue } from "../lib/settings.server";
import { subscriptionEvent, syncPlan, type AppSubscriptionPayload } from "../lib/plan-sync.server";

// app_subscriptions/update → sync the merchant's Shopify Managed Pricing plan
// to their SentientUI account. Retry contract mirrors the revenue forwarders:
// a failed sync 500s so Shopify retries (48h); an event that carries no plan
// change (unknown name, transient status) acks 200 because retrying cannot
// help. An unconfigured shop (no keys saved yet) also acks: the merchant's
// first "Save and connect" will run before they can buy a plan, and a plan
// bought before keys exist re-fires on the next subscription event.
export const action = async ({ request }: ActionFunctionArgs) => {
  // Not authenticate.webhook: a subscription ending around an uninstall comes
  // from a shop whose offline token is dead, and the library's refresh throws
  // a 500 before this handler runs — Shopify then retried a sync that could
  // never succeed (audit H8; see webhook-auth.server.ts).
  const { shop, topic, payload } = await authenticateWebhookAllowingExpiredToken(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const event = subscriptionEvent(payload as AppSubscriptionPayload);
  if (event === null) return new Response();

  const settings = await getSettings(shop);
  if (!settings?.secretKey) {
    console.log(`[sentient] ${topic} for ${shop} before keys were saved — nothing to sync`);
    return new Response();
  }

  const ok = await syncPlan(settings.secretKey, event.plan, shop, fetch, { event });
  if (ok === false) return new Response("plan sync failed", { status: 500 });
  if (ok === true) await clearPlanIssue(shop);
  if (ok === "refused") {
    // Applied nowhere: the account is billed another way (card, contract or a
    // grant), so Shopify's charge has to be refunded (review R9 M1).
    await recordPlanIssue(shop, `A plan bought here (${event.plan}) was not applied: your SentientUI account is already billed another way (card, contract or a grant). Contact SentientUI support to have the Shopify charge refunded.`);
    return new Response();
  }
  if (ok === "terminal") {
    console.error(`[sentient] ${topic} for ${shop}: plan sync refused permanently — acking so Shopify stops retrying`);
    // Shown in the admin: the merchant was charged by Shopify for a plan
    // SentientUI will not apply, and only the logs knew (review R8 M1).
    await recordPlanIssue(shop, `A plan change (${event.plan}) was not applied: SentientUI refused it — this store is disconnected from its project, or its key was revoked. Reconnect the store below.`);
  }
  return new Response();
};
