import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticateWebhookAllowingExpiredToken } from "../lib/webhook-auth.server";
import { forwardCustomerGdpr, orderIdsOf, type CustomerGdprPayload } from "../lib/customer-gdpr.server";

// GDPR compliance webhook — mandatory for every App Store listing.
//
// This app persists no per-customer rows, but the orders it forwards are stored
// by the SentientUI API under their Shopify order id, joined to the visitor's
// pseudonymous session. This used to answer 200 and erase nothing (audit H7).
// Now the API removes those order ids (the anonymous totals stay in revenue
// reporting). A failure 500s so Shopify retries — an erasure must not be lost.
export const action = async ({ request }: ActionFunctionArgs) => {
  // Fires after uninstall, when the shop's offline token is dead and
  // authenticate.webhook would 500 on the refresh — see webhook-auth.server.ts.
  const { shop, topic, payload } = await authenticateWebhookAllowingExpiredToken(request);
  const orderIds = orderIdsOf(payload as CustomerGdprPayload, "redact");
  if (orderIds.length === 0) {
    console.log(`[sentient] ${topic} for ${shop}: no orders named, nothing held to erase`);
    return new Response();
  }
  const result = await forwardCustomerGdpr("redact", shop, orderIds);
  if (!result) return new Response("redaction failed", { status: 500 });
  if (result.projects === 0) {
    // Honest log: no SentientUI project is bound to this shop, so nothing
    // here held the data (and nothing was changed).
    console.warn(`[sentient] ${topic} for ${shop}: no SentientUI project is connected to this shop — nothing held`);
  } else {
    console.log(`[sentient] ${topic} for ${shop}: redacted ${orderIds.length} order id(s) across ${result.projects} project(s)`);
  }
  return new Response();
};
