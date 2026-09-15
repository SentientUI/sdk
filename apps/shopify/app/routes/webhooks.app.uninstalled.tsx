import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { isStaleUninstall } from "../lib/drop-visibility";
import { syncPlan } from "../lib/plan-sync.server";
import { decryptSecret } from "../lib/secret-box";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Read the trigger time BEFORE authenticate.webhook consumes the request.
  const triggeredAt = Date.parse(request.headers.get("x-shopify-triggered-at") ?? "");
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Shopify guarantees at-least-once delivery and retries app/uninstalled for
  // 48h, so a duplicate can land AFTER the merchant has reinstalled and pasted
  // their keys again. Deleting unconditionally silently logged them out and
  // disconnected the shop, after which every order was dropped as unconfigured.
  // Two "the install is newer than the event" signals (see isStaleUninstall):
  // settings.updatedAt is the key re-paste's clock, and the newest Session
  // row's createdAt is the reinstall OAuth's clock — the latter covers the
  // window where the merchant has reinstalled but not yet re-saved keys, in
  // which the settings check alone still wiped their fresh login mid-setup.
  const [settings, newestSession] = await Promise.all([
    db.sentientSettings.findUnique({ where: { shop } }),
    db.session.findFirst({ where: { shop }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  if (isStaleUninstall(triggeredAt, settings?.updatedAt ?? null, newestSession?.createdAt ?? null)) {
    console.log(`[sentient] ignoring a stale ${topic} for ${shop} — reinstalled since it fired`);
    return new Response();
  }

  // Uninstalling cancels any Shopify Managed Pricing subscription, and the
  // app_subscriptions/update CANCELLED event can land AFTER the keys below
  // are deleted — at which point the sync can no longer authenticate and the
  // account would keep paid entitlements it stopped paying for. Release the
  // plan here first, best-effort (the API only downgrades accounts the
  // Shopify rail owns, so this is a no-op for Stripe-billed customers).
  if (settings?.secretKey) {
    // The raw Prisma row carries the enveloped sk_ (getSettings would decrypt,
    // but this handler reads directly for the staleness check above).
    await syncPlan(decryptSecret(settings.secretKey), "free", shop);
  }

  await db.session.deleteMany({ where: { shop } });
  // Data hygiene: the shop's stored SentientUI keys go with the install. The
  // merchant's SentientUI project itself is untouched — they own that account.
  await db.sentientSettings.deleteMany({ where: { shop } });

  return new Response();
};
