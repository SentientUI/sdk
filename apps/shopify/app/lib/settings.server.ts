// Per-shop SentientUI key storage + provisioning (README step 2). Server-only:
// the sk_ never leaves the app backend.
import prisma from '../db.server';
import { SENTIENT_API_DEFAULT } from './forward';
import { shouldRecordForward } from './drop-visibility';
import { decryptSecret, encryptSecret } from './secret-box';

export function sentientApiUrl(): string {
  return process.env.SENTIENT_API_URL || SENTIENT_API_DEFAULT;
}

export type ShopSettings = {
  publishableKey: string;
  secretKey: string;
  // Webhook health, for the settings-screen drop banner and the
  // recordForwardSuccess throttle (drop-visibility.ts).
  lastForwardAt: Date | null;
  lastDropAt: Date | null;
  lastDropReason: string | null;
};

export async function getSettings(shop: string): Promise<ShopSettings | null> {
  const row = await prisma.sentientSettings.findUnique({ where: { shop } });
  if (!row) return null;
  // The pk_ is public (it ships in the storefront snippet); only the sk_ is
  // enveloped. A row written before encryption was enabled comes back
  // unchanged — see secret-box.ts.
  return {
    publishableKey: row.publishableKey,
    secretKey: decryptSecret(row.secretKey),
    lastForwardAt: row.lastForwardAt,
    lastDropAt: row.lastDropAt,
    lastDropReason: row.lastDropReason,
  };
}

/** Persists a terminal webhook drop so the settings screen can warn the
 *  merchant (the Fly log line used to be the ONLY record — invisible to them).
 *  Never throws: a failed record must not turn the drop's 200 into a retry,
 *  and updateMany (not update) tolerates the row being deleted by a
 *  concurrent uninstall. */
export async function recordTerminalDrop(shop: string, reason: string): Promise<void> {
  try {
    await prisma.sentientSettings.updateMany({
      where: { shop },
      // The reason ends up in a Polaris banner; cap it so a huge API error
      // body doesn't bloat the row or the screen.
      data: { lastDropAt: new Date(), lastDropReason: reason.slice(0, 300) },
    });
  } catch (err) {
    console.error(`[sentient] failed to record webhook drop for ${shop}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Persists lastForwardAt after a successful forward — throttled by
 *  shouldRecordForward so a busy shop doesn't pay a DB write per webhook.
 *  Never throws: the forward already succeeded and must ack 200. */
export async function recordForwardSuccess(
  shop: string,
  settings: Pick<ShopSettings, 'lastForwardAt' | 'lastDropAt'>,
): Promise<void> {
  if (!shouldRecordForward(new Date(), settings.lastForwardAt, settings.lastDropAt)) return;
  try {
    await prisma.sentientSettings.updateMany({ where: { shop }, data: { lastForwardAt: new Date() } });
  } catch (err) {
    console.error(`[sentient] failed to record forward success for ${shop}: ${err instanceof Error ? err.message : err}`);
  }
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
      // The settings action awaits this, so a hung API used to hang the
      // merchant's save button indefinitely. Abort instead: the catch below
      // returns false, which surfaces as the "save again to retry" warning.
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
