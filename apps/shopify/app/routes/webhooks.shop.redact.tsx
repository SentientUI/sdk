import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { isStaleUninstall } from "../lib/drop-visibility";

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

  // Same staleness guard as webhooks.app.uninstalled — and it MUST be the same
  // one. This handler needs it even more: shop/redact fires ~48h AFTER the
  // uninstall, so a merchant who reinstalled and re-entered their keys inside
  // that window got sessions + settings wiped again — logged out, shop
  // disconnected, and every subsequent order silently dropped as unconfigured.
  //
  // An inline check here used to read ONLY settings.updatedAt, and required
  // the settings row to exist at all. That missed the exact merchant the
  // uninstall handler already protects: one who reinstalled (OAuth done, a
  // fresh Session row) but had NOT yet re-saved keys. The first uninstall
  // delivery had deleted their settings row, so there was no updatedAt to
  // prove the install was newer, and this redact wiped their brand-new
  // session mid-setup. isStaleUninstall's second clock — the newest Session
  // row's createdAt — exists precisely for that window; use it here too.
  //
  // Either clock being newer than the event means the shop is an active
  // install again; the redact obligation covered the OLD install's data,
  // which app/uninstalled (or a prior delivery of this webhook) already
  // erased.
  const [settings, newestSession] = await Promise.all([
    db.sentientSettings.findUnique({ where: { shop } }),
    db.session.findFirst({ where: { shop }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  if (isStaleUninstall(triggeredAt, settings?.updatedAt ?? null, newestSession?.createdAt ?? null)) {
    console.log(`[sentient] ignoring a stale ${topic} for ${shop} — reinstalled since it fired`);
    return new Response();
  }

  const [erasedSessions, erasedSettings] = await Promise.all([
    db.session.deleteMany({ where: { shop } }),
    db.sentientSettings.deleteMany({ where: { shop } }),
  ]);

  console.log(
    `[sentient] ${topic} for ${shop}: erased ${erasedSessions.count} session(s), ${erasedSettings.count} settings row(s)`,
  );
  return new Response();
};
