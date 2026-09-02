import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
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
  sessionStorage: new PrismaSessionStorage(prisma),
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
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
