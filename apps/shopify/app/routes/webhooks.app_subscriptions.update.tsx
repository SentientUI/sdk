import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSettings } from "../lib/settings.server";
import { planFromSubscription, syncPlan, type AppSubscriptionPayload } from "../lib/plan-sync.server";

// app_subscriptions/update → sync the merchant's Shopify Managed Pricing plan
// to their SentientUI account. Retry contract mirrors the revenue forwarders:
// a failed sync 500s so Shopify retries (48h); an event that carries no plan
// change (unknown name, transient status) acks 200 because retrying cannot
// help. An unconfigured shop (no keys saved yet) also acks: the merchant's
// first "Save and connect" will run before they can buy a plan, and a plan
// bought before keys exist re-fires on the next subscription event.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const plan = planFromSubscription(payload as AppSubscriptionPayload);
  if (plan === null) return new Response();

  const settings = await getSettings(shop);
  if (!settings?.secretKey) {
    console.log(`[sentient] ${topic} for ${shop} before keys were saved — nothing to sync`);
    return new Response();
  }

  const ok = await syncPlan(settings.secretKey, plan, shop);
  if (!ok) return new Response("plan sync failed", { status: 500 });
  return new Response();
};
