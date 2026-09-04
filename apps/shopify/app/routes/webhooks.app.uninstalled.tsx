import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { isStaleUninstall } from "../lib/drop-visibility";

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

  await db.session.deleteMany({ where: { shop } });
  // Data hygiene: the shop's stored SentientUI keys go with the install. The
  // merchant's SentientUI project itself is untouched — they own that account.
  await db.sentientSettings.deleteMany({ where: { shop } });

  return new Response();
};
