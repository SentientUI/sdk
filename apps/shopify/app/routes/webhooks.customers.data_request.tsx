import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticateWebhookAllowingExpiredToken } from "../lib/webhook-auth.server";
import { forwardCustomerGdpr, orderIdsOf, type CustomerGdprPayload } from "../lib/customer-gdpr.server";

// GDPR compliance webhook — mandatory for every App Store listing, and checked
// automatically during review. The HMAC is verified before the body is read.
//
// This app stores no customer data (per shop: the domain, the merchant's own
// SentientUI keys, the Shopify session). The SentientUI API does hold, per
// order this app forwarded, the order id, its total and currency, and the
// pseudonymous session it was attributed to. The API records what it holds
// for the requested orders in the project's audit log, which support hands to
// the store owner — the party Shopify's obligation runs to (audit H7).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticateWebhookAllowingExpiredToken(request);
  const orderIds = orderIdsOf(payload as CustomerGdprPayload, "export");
  if (orderIds.length === 0) {
    console.log(`[sentient] ${topic} for ${shop}: no orders named, nothing held`);
    return new Response();
  }
  const result = await forwardCustomerGdpr("export", shop, orderIds);
  if (!result) return new Response("data request failed", { status: 500 });
  if (result.projects === 0) {
    // Honest log: no SentientUI project is bound to this shop, so nothing
    // here held the data (and nothing was changed).
    console.warn(`[sentient] ${topic} for ${shop}: no SentientUI project is connected to this shop — nothing held`);
  } else {
    console.log(`[sentient] ${topic} for ${shop}: recorded a data request for ${orderIds.length} order id(s) across ${result.projects} project(s)`);
  }
  return new Response();
};
