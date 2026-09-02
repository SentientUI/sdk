import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Read the trigger time BEFORE authenticate.webhook consumes the request.
  const triggeredAt = Date.parse(request.headers.get("x-shopify-triggered-at") ?? "");
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Shopify guarantees at-least-once delivery and retries app/uninstalled for
  // 48h, so a duplicate can land AFTER the merchant has reinstalled and pasted
  // their keys again. Deleting unconditionally silently logged them out and
  // disconnected the shop, after which every order was dropped as unconfigured.
  // The stored row's updatedAt is the install's own clock: if it is newer than
  // the event, this uninstall has already been superseded.
  const settings = await db.sentientSettings.findUnique({ where: { shop } });
  if (settings && Number.isFinite(triggeredAt) && settings.updatedAt.getTime() > triggeredAt) {
    console.log(`[sentient] ignoring a stale ${topic} for ${shop} — reinstalled since it fired`);
    return new Response();
  }

  await db.session.deleteMany({ where: { shop } });
  // Data hygiene: the shop's stored SentientUI keys go with the install. The
  // merchant's SentientUI project itself is untouched — they own that account.
  await db.sentientSettings.deleteMany({ where: { shop } });

  return new Response();
};
