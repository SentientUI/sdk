import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// GDPR compliance webhook — mandatory for every App Store listing. Delivered
// 48h after an uninstall, and it is the obligation the uninstall handler cannot
// discharge on its own: this is the point at which every trace of the shop must
// be gone.
//
// app/uninstalled already clears both tables, so this is normally a no-op — but
// it must still exist and still delete, because an uninstall webhook that was
// never delivered (or was dropped during a deploy) leaves rows behind, and this
// is the backstop that catches them.
export const action = async ({ request }: ActionFunctionArgs) => {
  // Read the trigger time BEFORE authenticate.webhook consumes the request.
  const triggeredAt = Date.parse(request.headers.get("x-shopify-triggered-at") ?? "");
  const { shop, topic } = await authenticate.webhook(request);

  // Same staleness guard as webhooks.app.uninstalled, and this handler needs it
  // even more: shop/redact fires ~48h AFTER the uninstall, so a merchant who
  // reinstalled and re-entered their keys inside that window got sessions +
  // settings wiped again — logged out, shop disconnected, and every subsequent
  // order silently dropped as unconfigured. A settings row updated after the
  // event fired means the shop is an active install again; the redact
  // obligation covered the OLD install's data, which app/uninstalled (or a
  // prior delivery of this webhook) already erased.
  const current = await db.sentientSettings.findUnique({ where: { shop } });
  if (current && Number.isFinite(triggeredAt) && current.updatedAt.getTime() > triggeredAt) {
    console.log(`[sentient] ignoring a stale ${topic} for ${shop} — reinstalled since it fired`);
    return new Response();
  }

  const [sessions, settings] = await Promise.all([
    db.session.deleteMany({ where: { shop } }),
    db.sentientSettings.deleteMany({ where: { shop } }),
  ]);

  console.log(
    `[sentient] ${topic} for ${shop}: erased ${sessions.count} session(s), ${settings.count} settings row(s)`,
  );
  return new Response();
};
