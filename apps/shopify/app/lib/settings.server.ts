// Per-shop SentientUI key storage + provisioning (README step 2). Server-only:
// the sk_ never leaves the app backend.
import prisma from '../db.server';
import type { Prisma } from '@prisma/client';
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
  planIssueAt: Date | null;
  planIssueReason: string | null;
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
    planIssueAt: row.planIssueAt,
    planIssueReason: row.planIssueReason,
  };
}

/** A Shopify plan purchase or change SentientUI did not apply — shown until a
 *  later plan event is applied (clearPlanIssue), never cleared by orders.
 *  Raw like the other health writes (see recordForwardSuccess). Never throws. */
export async function recordPlanIssue(shop: string, reason: string): Promise<void> {
  try {
    await prisma.$executeRaw`UPDATE "SentientSettings" SET "planIssueAt" = ${new Date()}, "planIssueReason" = ${reason.slice(0, 300)} WHERE "shop" = ${shop}`;
  } catch (err) {
    console.error(`[sentient] failed to record a plan issue for ${shop}: ${err instanceof Error ? err.message : err}`);
  }
}

export async function clearPlanIssue(shop: string): Promise<void> {
  try {
    await prisma.$executeRaw`UPDATE "SentientSettings" SET "planIssueAt" = NULL, "planIssueReason" = NULL WHERE "shop" = ${shop} AND "planIssueAt" IS NOT NULL`;
  } catch (err) {
    console.error(`[sentient] failed to clear the plan issue for ${shop}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Persists a terminal webhook drop so the settings screen can warn the
 *  merchant (the Fly log line used to be the ONLY record — invisible to them).
 *  Never throws: a failed record must not turn the drop's 200 into a retry,
 *  and updateMany (not update) tolerates the row being deleted by a
 *  concurrent uninstall. */
export async function recordTerminalDrop(shop: string, reason: string): Promise<void> {
  try {
    // The reason ends up in a Polaris banner; cap it so a huge API error
    // body doesn't bloat the row or the screen. Raw, like the forward record:
    // see recordForwardSuccess.
    await prisma.$executeRaw`UPDATE "SentientSettings" SET "lastDropAt" = ${new Date()}, "lastDropReason" = ${reason.slice(0, 300)} WHERE "shop" = ${shop}`;
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
    // Raw SQL, not updateMany: Prisma's @updatedAt bumps on every client
    // update, and updatedAt is what the uninstall's staleness guard reads as
    // "keys saved at" — a forward or drop recorded after an uninstall fired
    // made its retry look stale, skipping the release and the wipe (review
    // R9). These health fields must never move it.
    await prisma.$executeRaw`UPDATE "SentientSettings" SET "lastForwardAt" = ${new Date()} WHERE "shop" = ${shop}`;
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

export type StorefrontCheck =
  | { ok: true }
  | { ok: false; reason: 'origin_not_allowed' | 'invalid_key' | 'unreachable' };

/** Asks the SentientUI API whether this publishable key is accepted from this
 *  storefront origin — the exact check the snippet's session/decision/event
 *  calls fail on, minus the side effects.
 *
 *  It exists because that failure had no voice. An unallowed origin 403s every
 *  storefront request, and the merchant's only evidence was a dashboard that
 *  stayed empty; the Shopify App Store rejected the app over it (round 3,
 *  2026-09-21, 5.1.2) after a reviewer enabled the theme embed and saw nothing
 *  work. Forging the Origin header from the server is deliberate: it
 *  reproduces the browser's request faithfully without a browser.
 *
 *  Never throws — the settings screen renders whatever comes back. The reasons
 *  are kept apart because their fixes are different: a 403 means save again to
 *  allowlist the domain, a 401 means the pasted key is wrong. */
export async function checkStorefrontOrigin(
  publishableKey: string,
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StorefrontCheck> {
  try {
    const res = await fetchImpl(`${sentientApiUrl()}/v1/origin-check`, {
      headers: { authorization: `Bearer ${publishableKey}`, origin },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 403) return { ok: false, reason: 'origin_not_allowed' };
    if (res.status === 401) return { ok: false, reason: 'invalid_key' };
    return { ok: false, reason: 'unreachable' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/** Idempotent server-side bootstrap: creates the 'purchase' goal and the
 *  template 'checkout' funnel for the project the sk_ belongs to, and
 *  allowlists the storefront origins so the snippet's ingest passes the Origin
 *  check without a manual dashboard step (App Store reviewers test on
 *  freshly-minted myshopify domains nobody can pre-add — the 4.5.4/core-flow
 *  wall in the 2026-09-06 review). A failure is surfaced to the merchant but
 *  does not block saving keys — the endpoint can be retried by saving again. */
export type ProvisionResult = {
  ok: boolean;
  /** The shop's connection to the key's project, as the API reports it: a
   *  store disconnected in the dashboard still provisions with a pasted key,
   *  and without this the admin looked healthy while every plan purchase was
   *  refused (review R8 M1). */
  binding: 'live' | 'disconnected' | 'detached' | null;
};

export async function provisionSentient(
  secretKey: string,
  domains: { shopDomain?: string; primaryDomain?: string; subscriptionObserved?: 'none' } = {},
): Promise<ProvisionResult> {
  try {
    // A JSON body is load-bearing even when domains are absent: Fastify 400s a
    // json content-type with NO body (FST_ERR_CTP_EMPTY_JSON_BODY) before auth
    // even runs.
    const res = await fetch(`${sentientApiUrl()}/v1/provision/shopify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secretKey}`,
        // Proves this call comes from the app, not just any sk_ holder: the API
        // records the shop → project binding only then (review R2 M5).
        ...(process.env.SHOPIFY_CONNECTOR_SECRET ? { 'x-connector-secret': process.env.SHOPIFY_CONNECTOR_SECRET } : {}),
      },
      body: JSON.stringify(domains),
      // The settings action awaits this, so a hung API used to hang the
      // merchant's save button indefinitely. Abort instead: the catch below
      // returns false, which surfaces as the "save again to retry" warning.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, binding: null };
    let binding: ProvisionResult['binding'] = null;
    try {
      const b = ((await res.json()) as { binding?: unknown }).binding;
      if (b === 'live' || b === 'disconnected' || b === 'detached') binding = b;
    } catch {
      /* an older API answers without it */
    }
    return { ok: true, binding };
  } catch {
    return { ok: false, binding: null };
  }
}

// Zero-key connect (audit H11): keys waiting for the merchant's confirmation.
export type PendingConnectRow = { publishableKey: string; secretKey: string; projectId: string; projectName: string; createdAt: Date };

/** Best-effort: revoke a zero-key pair the app is dropping, so no live key
 *  outlives the connection it was minted for (review R2 M1/N3). The API only
 *  revokes pairs its connect route minted — a pasted key is never touched. */
export async function revokeConnectPair(
  secretKey: string,
  opts: { keepPk?: boolean; sweepOlder?: boolean } = {},
): Promise<void> {
  const connectorSecret = process.env.SHOPIFY_CONNECTOR_SECRET;
  if (!connectorSecret || !secretKey.startsWith('sk_')) return;
  try {
    await fetch(`${sentientApiUrl()}/v1/provision/shopify/connect/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secretKey}`, 'x-connector-secret': connectorSecret },
      // keepPk: the storefront still uses this pair's pk_ (a merchant who
      // pasted only a new sk_). sweepOlder: called with the LIVE key, revokes
      // this shop's older connect pairs instead of this one.
      body: JSON.stringify(opts),
      signal: AbortSignal.timeout(3_500),
    });
  } catch {
    /* best-effort; the pair is unused either way */
  }
}

/** Serialises a delivery with a confirm for the same shop: unlocked, a
 *  delivery landing between the confirm's read and its save saw the confirmed
 *  pair as "not live yet" and revoked it — the store then ran on a dead key
 *  (review R4 N7). */
const lockShop = (tx: Prisma.TransactionClient, shop: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'sentient-connect:' + shop}))`;

export async function savePendingConnect(
  shop: string,
  p: { publishableKey: string; secretKey: string; projectId: string; projectName: string },
): Promise<void> {
  const toRevoke = await prisma.$transaction(async (tx) => {
    await lockShop(tx, shop);
    // A newer delivery replaces an older one: the pair being replaced is
    // revoked (below, after commit) — unless it has become the live key.
    const previous = await tx.pendingConnect.findUnique({ where: { shop } });
    let revoke: string | null = null;
    if (previous) {
      try {
        const prevSecret = decryptSecret(previous.secretKey);
        const live = await tx.sentientSettings.findUnique({ where: { shop } });
        const liveSecret = live ? decryptSecret(live.secretKey) : null;
        if (prevSecret !== liveSecret) revoke = prevSecret;
      } catch {
        /* unreadable envelope: nothing to revoke with */
      }
    }
    const secretKey = encryptSecret(p.secretKey);
    await tx.pendingConnect.upsert({
      where: { shop },
      create: { shop, ...p, secretKey },
      update: { ...p, secretKey, createdAt: new Date() },
    });
    return revoke;
  });
  if (toRevoke) await revokeConnectPair(toRevoke);
}

/** Confirm, atomically with any delivery for the same shop: the pending row
 *  must still be the one the banner showed (project + createdAt); it becomes
 *  the stored keys and is removed in one step. Null when it changed. */
export async function confirmPendingConnect(
  shop: string,
  shown: { projectId: string; createdAt: string },
): Promise<{ publishableKey: string; secretKey: string } | null> {
  return prisma.$transaction(async (tx) => {
    await lockShop(tx, shop);
    const row = await tx.pendingConnect.findUnique({ where: { shop } });
    if (!row || row.projectId !== shown.projectId || row.createdAt.toISOString() !== shown.createdAt) return null;
    let secretKey: string;
    try {
      secretKey = decryptSecret(row.secretKey);
    } catch {
      return null;
    }
    await tx.sentientSettings.upsert({
      where: { shop },
      create: { shop, publishableKey: row.publishableKey, secretKey: row.secretKey },
      update: { publishableKey: row.publishableKey, secretKey: row.secretKey },
    });
    await tx.pendingConnect.delete({ where: { shop } });
    return { publishableKey: row.publishableKey, secretKey };
  });
}

/** The pending connection, or null. Older than a day is treated as abandoned
 *  (and removed): a stale offer should not sit on the settings screen. */
export async function getPendingConnect(shop: string, now = Date.now()): Promise<PendingConnectRow | null> {
  const row = await prisma.pendingConnect.findUnique({ where: { shop } });
  if (!row) return null;
  if (now - row.createdAt.getTime() > 24 * 60 * 60 * 1000) {
    // Through the locked discard, bound to this row: an unlocked drop racing
    // a confirm in another tab revoked the key that confirm made live
    // (review R6 L2).
    await deletePendingConnect(shop, { revoke: true, createdAt: row.createdAt });
    return null;
  }
  // A rotated SETTINGS_ENCRYPTION_KEY made this throw and took the whole
  // admin page down for a day (review R3): an unreadable offer is dropped.
  try {
    return { ...row, secretKey: decryptSecret(row.secretKey) };
  } catch {
    await prisma.pendingConnect.deleteMany({ where: { shop } });
    return null;
  }
}

/** Drop the pending connection; `revoke` also kills its pair (a discard). A
 *  confirmed pair is kept — it is now the shop's live key. */
export async function deletePendingConnect(shop: string, opts: { revoke?: boolean; createdAt?: Date } = {}): Promise<void> {
  // Under the same per-shop lock as confirm and delivery: a Discard racing a
  // Confirm of the same offer revoked the pair the confirm had just made live
  // (review R5 L3). Never the live key, and only the row asked about (a
  // discard is bound to what the page showed).
  const toRevoke = await prisma.$transaction(async (tx) => {
    await lockShop(tx, shop);
    const row = await tx.pendingConnect.findUnique({ where: { shop } });
    if (!row || (opts.createdAt && row.createdAt.getTime() !== opts.createdAt.getTime())) return null;
    await tx.pendingConnect.delete({ where: { shop } });
    if (!opts.revoke) return null;
    try {
      const secret = decryptSecret(row.secretKey);
      const live = await tx.sentientSettings.findUnique({ where: { shop } });
      return live && decryptSecret(live.secretKey) === secret ? null : secret;
    } catch {
      return null;
    }
  });
  if (toRevoke) await revokeConnectPair(toRevoke);
}

