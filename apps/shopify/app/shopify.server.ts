import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { EncryptedSessionStorage } from "./lib/session-storage.server";

// Fail at boot, not at HMAC time. `SHOPIFY_API_SECRET || ""` booted happily
// with an empty secret and then every webhook signature check and OAuth
// exchange failed with opaque 401s — hours into serving, far from the cause.
// An app that cannot verify a single request has no business starting.
if (!process.env.SHOPIFY_API_SECRET) {
  throw new Error(
    "SHOPIFY_API_SECRET is not set (or empty). The app cannot verify webhook " +
      "HMACs or complete OAuth without it — set it before starting the server.",
  );
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  // MUST match `api_version` in shopify.app.toml, and must be a version the
  // INSTALLED library knows. These were two years apart (2025-01 here, 2026-10
  // in the toml), so webhook payloads arrived in one shape while the Admin API
  // was called in another — and the toml named a version @shopify/shopify-api
  // 13.1 has no constant for at all. 2026-07 is the newest it supports; moving
  // past it means upgrading the library FIRST, then both of these together.
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  // Wrapped so Session.accessToken/refreshToken get the same at-rest envelope
  // as the merchant sk_ — see session-storage.server.ts for the lazy-migration
  // contract (plaintext rows stay readable; writes are encrypted).
  sessionStorage: new EncryptedSessionStorage(new PrismaSessionStorage(prisma)),
  distribution: AppDistribution.AppStore,
  // NO Shopify billing, deliberately.
  //
  // The merchant pays SentientUI for what SentientUI does — priced on traffic
  // (session tiers, billed by Stripe on their SentientUI account). This app is
  // the connector to that account, not a product with its own price. Charging
  // here would bill the same customer twice for the same service on two rails,
  // and it would price the connector rather than the value.
  //
  // Shopify requires the Billing API for charges made *for an app*, with a
  // carve-out for a service the merchant buys independently and can use off
  // Shopify — which is exactly this: SentientUI has its own signup, its own
  // plans, and customers with no Shopify store at all. Expect review to ask;
  // the answer is that the app itself is free and the subscription is not a
  // Shopify app charge. See README "Pricing and billing".
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const login = shopify.login;
export const sessionStorage = shopify.sessionStorage;
