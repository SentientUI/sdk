import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// GDPR compliance webhook — mandatory for every App Store listing.
//
// Nothing to erase: this app persists no per-customer rows (see
// webhooks.customers.data_request for the full inventory of what it does
// store). Answer 200 so Shopify records the obligation as met rather than
// retrying for 48h against a 404.
//
// If this app ever starts persisting customer-scoped rows, the deletion has to
// happen HERE — an empty handler that silently keeps data is worse than none.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`[sentient] ${topic} for ${shop}: no customer records held, nothing to erase`);
  return new Response();
};
