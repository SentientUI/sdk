import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

import { login } from "../../shopify.server";

// Classic-OAuth fallback entry. A valid ?shop= makes login() THROW a redirect
// into the OAuth flow, so the line after it only runs for shop-less or
// invalid-shop visits — those used to get the template's shop-domain form,
// which App Store requirement 2.3.1 forbids (no manual .myshopify.com entry).
// Every legitimate caller arrives with the shop already in the URL, so
// everyone else goes back to the marketing root.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await login(request);

  throw redirect("/");
};
