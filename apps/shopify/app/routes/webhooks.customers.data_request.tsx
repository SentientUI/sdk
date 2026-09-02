import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// GDPR compliance webhook — mandatory for every App Store listing, and checked
// automatically during review. `authenticate.webhook` verifies the HMAC and
// throws (401) on a bad signature, so an unsigned probe never reaches the body.
//
// This app stores no customer-identifiable data. Per shop it holds only the
// domain and the merchant's own SentientUI keys (SentientSettings), plus the
// Shopify session. Orders and refunds are forwarded to the SentientUI API and
// never persisted here — what we send is the order id and its total, never a
// name, email or address. So there is nothing to return for a data request;
// the obligation is to acknowledge it, which is what a 200 does.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`[sentient] ${topic} for ${shop}: no customer data is stored by this app`);
  return new Response();
};
