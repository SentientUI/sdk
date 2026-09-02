// Per-shop SentientUI key storage + provisioning (README step 2). Server-only:
// the sk_ never leaves the app backend.
import prisma from '../db.server';
import { SENTIENT_API_DEFAULT } from './forward';
import { decryptSecret, encryptSecret } from './secret-box';

export function sentientApiUrl(): string {
  return process.env.SENTIENT_API_URL || SENTIENT_API_DEFAULT;
}

export async function getSettings(shop: string): Promise<{ publishableKey: string; secretKey: string } | null> {
  const row = await prisma.sentientSettings.findUnique({ where: { shop } });
  if (!row) return null;
  // The pk_ is public (it ships in the storefront snippet); only the sk_ is
  // enveloped. A row written before encryption was enabled comes back
  // unchanged — see secret-box.ts.
  return { publishableKey: row.publishableKey, secretKey: decryptSecret(row.secretKey) };
}

export async function saveSettings(shop: string, publishableKey: string, secretKey: string): Promise<void> {
  const enveloped = encryptSecret(secretKey);
  await prisma.sentientSettings.upsert({
    where: { shop },
    create: { shop, publishableKey, secretKey: enveloped },
    update: { publishableKey, secretKey: enveloped },
  });
}

export async function deleteSettings(shop: string): Promise<void> {
  await prisma.sentientSettings.deleteMany({ where: { shop } });
}

/** Idempotent server-side bootstrap: creates the 'purchase' goal and the
 *  template 'checkout' funnel for the project the sk_ belongs to. A failure is
 *  surfaced to the merchant but does not block saving keys — the endpoint can
 *  be retried by saving again. */
export async function provisionSentient(secretKey: string): Promise<boolean> {
  try {
    // The empty JSON body is load-bearing: Fastify 400s a json content-type
    // with NO body (FST_ERR_CTP_EMPTY_JSON_BODY) before auth even runs.
    const res = await fetch(`${sentientApiUrl()}/v1/provision/shopify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secretKey}` },
      body: JSON.stringify({}),
    });
    return res.ok;
  } catch {
    return false;
  }
}
