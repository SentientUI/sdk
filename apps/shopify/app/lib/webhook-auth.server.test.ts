import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('../shopify.server', () => ({ authenticate: { webhook: vi.fn() } }));

import { authenticate } from '../shopify.server';
import { authenticateWebhookAllowingExpiredToken, verifyWebhookHmac } from './webhook-auth.server';

const webhook = authenticate.webhook as unknown as ReturnType<typeof vi.fn>;
const SECRET = 'test-app-secret';
const BODY = JSON.stringify({ shop_id: 1, shop_domain: 'dead.myshopify.com' });

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

function makeRequest(body = BODY, hmac = sign(body)): Request {
  return new Request('https://app.test/webhooks/shop/redact', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': hmac,
      'x-shopify-shop-domain': 'dead.myshopify.com',
      'x-shopify-topic': 'shop/redact',
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_API_SECRET = SECRET;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.SHOPIFY_API_SECRET;
});

describe('verifyWebhookHmac', () => {
  it('accepts a correct signature and rejects a wrong one', () => {
    expect(verifyWebhookHmac(BODY, sign(BODY), SECRET)).toBe(true);
    expect(verifyWebhookHmac(BODY, sign(BODY, 'other-secret'), SECRET)).toBe(false);
    expect(verifyWebhookHmac(`${BODY} `, sign(BODY), SECRET)).toBe(false);
  });

  it('rejects a missing, empty or malformed header instead of throwing', () => {
    expect(verifyWebhookHmac(BODY, null, SECRET)).toBe(false);
    expect(verifyWebhookHmac(BODY, '', SECRET)).toBe(false);
    expect(verifyWebhookHmac(BODY, 'not base64 at all!!', SECRET)).toBe(false);
  });
});

// Why this helper exists: @shopify/shopify-app-remix runs
// ensureValidOfflineSession on EVERY webhook, compliance topics included. With
// `expiringOfflineAccessTokens` on, an expired offline token makes it call
// Shopify's token endpoint, and refresh-token.js throws a hardcoded
// `500 Internal Server Error` when that fails. For an uninstalled or closed
// store the refresh token is dead permanently, so app/uninstalled and
// shop/redact 500 forever — which is exactly what happened on 2026-09-21
// (90% and 100% failure rates, retried for hours, data never erased).
describe('authenticateWebhookAllowingExpiredToken', () => {
  it('uses the library result when authentication succeeds', async () => {
    webhook.mockResolvedValue({ shop: 's.myshopify.com', topic: 'SHOP_REDACT', payload: { a: 1 } });
    await expect(authenticateWebhookAllowingExpiredToken(makeRequest())).resolves.toEqual({
      shop: 's.myshopify.com',
      topic: 'SHOP_REDACT',
      payload: { a: 1 },
    });
  });

  it('falls back when the library throws its 500 Response, once the HMAC proves the request genuine', async () => {
    webhook.mockRejectedValue(new Response(undefined, { status: 500 }));
    await expect(authenticateWebhookAllowingExpiredToken(makeRequest())).resolves.toEqual({
      shop: 'dead.myshopify.com',
      topic: 'shop/redact',
      payload: { shop_id: 1, shop_domain: 'dead.myshopify.com' },
    });
  });

  it('also falls back for the invalid_subject_token error, which surfaces as a plain Error', async () => {
    // refresh-token.js rethrows HttpResponseError/InvalidJwtError as-is rather
    // than as a Response, so the fallback cannot key off Response alone.
    webhook.mockRejectedValue(new Error('invalid_subject_token'));
    await expect(authenticateWebhookAllowingExpiredToken(makeRequest())).resolves.toMatchObject({
      shop: 'dead.myshopify.com',
    });
  });

  it('NEVER falls back on a bad signature — the HMAC is the gate, not the library error', async () => {
    webhook.mockRejectedValue(new Response(undefined, { status: 500 }));
    const forged = makeRequest(BODY, sign(BODY, 'attacker-secret'));
    await expect(authenticateWebhookAllowingExpiredToken(forged)).rejects.toBeInstanceOf(Response);
  });

  it('rethrows the library rejection for a request it refused outright (401/400/405)', async () => {
    for (const status of [400, 401, 405]) {
      webhook.mockRejectedValue(new Response(undefined, { status }));
      const err = await authenticateWebhookAllowingExpiredToken(makeRequest()).catch((e) => e);
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBe(status);
    }
  });

  it('rethrows when the app secret is unset rather than trusting unverifiable headers', async () => {
    delete process.env.SHOPIFY_API_SECRET;
    webhook.mockRejectedValue(new Response(undefined, { status: 500 }));
    await expect(authenticateWebhookAllowingExpiredToken(makeRequest())).rejects.toBeDefined();
  });

  it('rethrows when the shop or topic header is missing — there is nothing to act on', async () => {
    webhook.mockRejectedValue(new Response(undefined, { status: 500 }));
    const req = new Request('https://app.test/webhooks/shop/redact', {
      method: 'POST',
      headers: { 'x-shopify-hmac-sha256': sign(BODY) },
      body: BODY,
    });
    await expect(authenticateWebhookAllowingExpiredToken(req)).rejects.toBeDefined();
  });

  it('leaves the request body readable by the library (it is replayed, not consumed)', async () => {
    webhook.mockImplementation(async (req: Request) => {
      expect(await req.text()).toBe(BODY);
      return { shop: 'x', topic: 't', payload: {} };
    });
    await authenticateWebhookAllowingExpiredToken(makeRequest());
    expect(webhook).toHaveBeenCalled();
  });
});
