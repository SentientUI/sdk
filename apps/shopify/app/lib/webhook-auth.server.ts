import { createHmac, timingSafeEqual } from "node:crypto";
import { authenticate } from "../shopify.server";

export type WebhookIdentity = { shop: string; topic: string; payload: unknown };

/** Constant-time check of Shopify's `X-Shopify-Hmac-SHA256` over the raw body.
 *
 *  This is the same proof `authenticate.webhook` makes; it is duplicated here
 *  only so the fallback below can stand on its own rather than on an assumption
 *  about which order the library does things in. Returns false for a missing,
 *  empty or malformed header — never throws, so a hostile value cannot turn
 *  into a 500. */
export function verifyWebhookHmac(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const provided = Buffer.from(header, "base64");
  // timingSafeEqual throws on a length mismatch, and Buffer.from silently
  // truncates junk base64, so the length guard is load-bearing.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * `authenticate.webhook`, but survivable when the shop's offline token is dead.
 *
 * The library runs `ensureValidOfflineSession` on EVERY webhook — compliance
 * topics included. With `expiringOfflineAccessTokens` enabled (see
 * shopify.server.ts), an offline token within 5 minutes of expiry makes it call
 * Shopify's token endpoint, and the library's refresh-token helper throws a
 * hardcoded `500 Internal Server Error` when that call fails (or rethrows
 * `HttpResponseError`/`InvalidJwtError` for `invalid_subject_token`).
 *
 * For an UNINSTALLED or CLOSED store the refresh token is dead permanently — so
 * every delivery 500s inside authentication, before any handler code runs, and
 * Shopify retries for 48h against something that can never succeed. That is
 * exactly what happened on 2026-09-21: app/uninstalled at a 90% failure rate
 * and shop/redact at 100%, all for one closed review store, while a different
 * shop's uninstall succeeded in the middle of the same window. The real damage
 * is not the failure rate: it is that the erasure those webhooks exist to
 * perform never ran.
 *
 * The topics that must not depend on a live token are precisely the ones that
 * fire once the shop is gone: app/uninstalled and the three GDPR topics. So
 * when authentication fails for a reason that is NOT a rejection of the request
 * itself, fall back to proving the request genuine ourselves and carry on with
 * no session — which those handlers never needed.
 *
 * The HMAC is the gate. A forged request fails it and the original error is
 * rethrown, so this widens nothing: it only declines to let a dead access token
 * stop us from honouring a request Shopify really did send.
 */
export async function authenticateWebhookAllowingExpiredToken(
  request: Request,
): Promise<WebhookIdentity> {
  // Read the body once and hand the library a replay of it. Cloning would work
  // too, but an unread clone keeps the tee'd stream alive; this way there is
  // exactly one buffer and the fallback is guaranteed to have it.
  const rawBody = await request.text();
  const replay = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: rawBody,
  });

  try {
    const { shop, topic, payload } = await authenticate.webhook(replay);
    return { shop, topic, payload };
  } catch (err) {
    // 400/401/405 are the library refusing the REQUEST (bad HMAC, malformed,
    // wrong method). Those are final — never paper over them.
    if (err instanceof Response && [400, 401, 405].includes(err.status)) throw err;

    const shop = request.headers.get("x-shopify-shop-domain");
    const topic = request.headers.get("x-shopify-topic");
    const secret = process.env.SHOPIFY_API_SECRET ?? "";
    if (
      !shop ||
      !topic ||
      !verifyWebhookHmac(rawBody, request.headers.get("x-shopify-hmac-sha256"), secret)
    ) {
      throw err;
    }

    console.error(
      `[sentient] ${topic} for ${shop}: the Shopify session could not be loaded or refreshed ` +
        `(usually an uninstalled or closed store, whose refresh token is dead for good). ` +
        `HMAC verified, so continuing without a session. ` +
        `(${err instanceof Response ? `${err.status} from authenticate.webhook` : String(err)})`,
    );

    let payload: unknown = {};
    try {
      payload = JSON.parse(rawBody);
    } catch {
      /* compliance payloads are small and well-formed; an unparseable one is
         still worth acting on for the topics that only need the shop. */
    }
    return { shop, topic, payload };
  }
}
