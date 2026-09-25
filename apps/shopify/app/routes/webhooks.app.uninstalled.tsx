import type { ActionFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { isStaleUninstall } from "../lib/drop-visibility";
import { planSyncConfigured, syncPlan } from "../lib/plan-sync.server";
import { decryptSecret } from "../lib/secret-box";
import { revokeConnectPair } from "../lib/settings.server";
import { authenticateWebhookAllowingExpiredToken } from "../lib/webhook-auth.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Read the trigger time BEFORE the body is consumed for HMAC validation.
  const triggeredAt = Date.parse(request.headers.get("x-shopify-triggered-at") ?? "");
  // NOT authenticate.webhook: an uninstall is by definition a shop whose
  // offline token is on its way out, and the library's refresh attempt 500s
  // before the wipe below can run. See webhook-auth.server.ts.
  const { shop, topic } = await authenticateWebhookAllowingExpiredToken(request);

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
  //
  // `disconnect: true` additionally hands the billing rail back: the rail is
  // claimed when the store CONNECTS (so a free Shopify merchant is never shown
  // a card upgrade — App Store 1.2.1), so without a release here every
  // merchant who ever installed would be locked out of paying by card forever.
  if (settings?.secretKey) {
    // The raw Prisma row carries the enveloped sk_ (getSettings would decrypt,
    // but this handler reads directly for the staleness check above).
    //
    // decryptSecret THROWS when the envelope cannot be opened — the
    // SETTINGS_ENCRYPTION_KEY was rotated or lost. Unguarded, that threw
    // straight out of the handler, BEFORE the deletes below, so the shop's
    // data was never erased and Shopify retried for 48h against an error that
    // could never resolve. (Latent, not the cause of the 2026-09-21 storm —
    // that was the token refresh in webhook-auth.server.ts — but the same
    // shape of bug, and this is the only other throw on the path.)
    //
    // An unreadable key is PERMANENT, so it is a terminal condition, not a
    // retryable one: skip the release (it could not authenticate with a key we
    // cannot read) and get on with the erasure, which is the obligation that
    // actually matters here.
    let secret: string | null = null;
    try {
      secret = decryptSecret(settings.secretKey);
    } catch (err) {
      console.error(
        `[sentient] cannot decrypt the stored key for ${shop} — SETTINGS_ENCRYPTION_KEY is ` +
          `missing or was rotated. Releasing the billing rail is impossible; erasing anyway. ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (secret && !planSyncConfigured()) {
      // Same shape as the unreadable key above: permanent until the operator
      // acts, so erase anyway instead of 500ing the uninstall for 48h.
      console.error(`[sentient] SHOPIFY_CONNECTOR_SECRET is not set — cannot release the billing rail for ${shop}; erasing anyway`);
    } else if (secret) {
      const released = await syncPlan(secret, "free", shop, fetch, {
        disconnect: true,
        forbiddenIsTerminal: true,
        ...(Number.isFinite(triggeredAt) ? { releasedAt: new Date(triggeredAt).toISOString() } : {}),
      });
      // The keys are deleted below, after which this can never be retried — so
      // a failure strands the account on a rail with no plan page to buy from.
      // Unlike a bad envelope this IS transient (the API was unreachable), so
      // 500: Shopify retries for 48h, and the staleness guard above makes the
      // retry safe.
      if (released === false) {
        console.error(`[sentient] releasing the billing rail for ${shop} failed — retrying via webhook`);
        return new Response("plan release failed", { status: 500 });
      }
      // Permanent (the key was revoked from the dashboard, and the shop is
      // not bound): retrying can't succeed, so erase anyway instead of 500ing
      // for 48 h with the shop's data kept (review R4 N1/M3).
      if (released === "terminal") console.error(`[sentient] releasing the billing rail for ${shop} was refused permanently — erasing anyway`);
    }
  }

  // A zero-key pair dies with the install — the app is the only holder, and
  // the key is still valid here to authorize its own revoke (review R3 N4).
  // Pasted keys are left alone by the API.
  if (settings?.secretKey) {
    try {
      await revokeConnectPair(decryptSecret(settings.secretKey));
    } catch {
      /* unreadable envelope: nothing to revoke with */
    }
  }
  const pending = await db.pendingConnect.findUnique({ where: { shop } });
  if (pending) {
    try {
      await revokeConnectPair(decryptSecret(pending.secretKey));
    } catch {
      /* unreadable envelope */
    }
  }
  await db.session.deleteMany({ where: { shop } });
  // Data hygiene: the shop's stored SentientUI keys go with the install. The
  // merchant's SentientUI project itself is untouched — they own that account.
  await db.sentientSettings.deleteMany({ where: { shop } });
  // A connection still waiting for confirmation holds an sk_ too.
  await db.pendingConnect.deleteMany({ where: { shop } });

  return new Response();
};
