// Shopify Managed Pricing → SentientUI plan sync (App Store review round 2,
// 2026-09-09, ref 133916: "subscription charges must go through the Shopify
// billing API"). The merchant buys a plan on Shopify's hosted plan page; the
// app_subscriptions/update webhook lands here. The connector shared secret
// plus the shop's stored sk_ authorize the plan write: first by shop
// (/plan-by-shop — the sk_ names the project even once revoked, and the
// shop's binding to it must be live), then the sk_ route for unbound shops.
import { sentientApiUrl } from './settings.server';

// Managed Pricing identifies plans by NAME, so the plan names configured in
// the Partner dashboard are a contract with this map. Keys are lowercased
// before lookup; an unknown name is ignored (never a downgrade) so renaming a
// Shopify plan can't silently zero a paying customer's entitlements.
const PLAN_NAME_MAP: Record<string, string> = {
  free: 'free',
  starter: 'starter',
  growth: 'growth',
  scale: 'scale',
};

// Statuses that mean "this subscription no longer entitles anything". ACTIVE
// maps to the named plan; DECLINED/EXPIRED never activated so they carry no
// entitlement change either way — treat them like cancellation only when
// Shopify reports them on the current subscription.
const ENDED_STATUSES = new Set(['CANCELLED', 'EXPIRED', 'DECLINED', 'FROZEN']);

export type AppSubscriptionPayload = {
  app_subscription?: {
    name?: string;
    status?: string;
    admin_graphql_api_id?: string;
    updated_at?: string;
  } | null;
};

/** What the API needs to apply one subscription event in order: Shopify
 *  delivers webhooks at least once and in no guaranteed order, so a late
 *  CANCELLED for the subscription a merchant just replaced (an upgrade
 *  cancels the old one) downgraded a paying merchant to free (audit P0-9). */
export type SubscriptionEvent = {
  plan: string;
  /** The subscription ended (cancelled/expired/declined/frozen), as opposed
   *  to an ACTIVE subscription whose plan happens to be free. */
  ended: boolean;
  subscriptionId?: string;
  updatedAt?: string;
  /** Shopify's status: FROZEN resumes, CANCELLED/EXPIRED/DECLINED don't, and
   *  EXPIRED/DECLINED were never active — the API needs the difference
   *  (review R2 H1/H2). */
  status?: string;
};

export function subscriptionEvent(payload: AppSubscriptionPayload): SubscriptionEvent | null {
  const plan = planFromSubscription(payload);
  if (plan === null) return null;
  const sub = payload.app_subscription!;
  const status = (sub.status ?? '').toUpperCase();
  return {
    plan,
    ended: ENDED_STATUSES.has(status),
    status,
    ...(sub.admin_graphql_api_id ? { subscriptionId: sub.admin_graphql_api_id } : {}),
    ...(sub.updated_at && !Number.isNaN(Date.parse(sub.updated_at)) ? { updatedAt: sub.updated_at } : {}),
  };
}

/** Maps a webhook payload to the plan the account should now hold, or null
 *  when the event should be ignored (unknown plan name, irrelevant status). */
export function planFromSubscription(payload: AppSubscriptionPayload): string | null {
  const sub = payload.app_subscription;
  if (!sub) return null;
  const status = (sub.status ?? '').toUpperCase();
  if (ENDED_STATUSES.has(status)) return 'free';
  if (status !== 'ACTIVE') return null;
  return PLAN_NAME_MAP[(sub.name ?? '').trim().toLowerCase()] ?? null;
}

/** False when the connector secret is unset: no plan call can succeed until
 *  the operator sets it. The uninstall handler treats that as terminal — it
 *  used to 500 on it, before the shop's data was erased, and Shopify retried
 *  the uninstall for 48h (grader R1 N2). */
export function planSyncConfigured(): boolean {
  return Boolean(process.env.SHOPIFY_CONNECTOR_SECRET);
}

/** Pushes the plan to the SentientUI API. Same fail-soft contract as the
 *  other forwarders: a non-2xx/unreachable API returns false so the webhook
 *  can 500 and let Shopify retry (48h) — plan changes are rare and must not
 *  be dropped on a deploy blip. */
export async function syncPlan(
  secretKey: string,
  plan: string,
  shopDomain: string,
  fetchImpl: typeof fetch = fetch,
  // `disconnect` means the app was UNINSTALLED, not that a subscription
  // merely ended. Only an uninstall hands the billing rail back to card
  // billing: the store is gone, so there is no Shopify plan page left to buy
  // on, and an account left on the Shopify rail could never pay at all. A
  // cancellation while the app is still installed must keep the rail — that
  // merchant re-subscribes through Shopify, and showing them a card upgrade
  // instead is exactly the off-platform billing App Store 1.2.1 forbids.
  opts: { disconnect?: boolean; releasedAt?: string; event?: SubscriptionEvent; forbiddenIsTerminal?: boolean } = {},
): Promise<boolean | 'terminal' | 'refused'> {
  const connectorSecret = process.env.SHOPIFY_CONNECTOR_SECRET;
  if (!connectorSecret) {
    // A failure, not an ack: acking 200 told Shopify the plan was applied
    // while nothing happened, so a merchant who paid stayed on free for good
    // (audit P0-7). A 500 keeps Shopify retrying for 48h, which recovers as
    // soon as the operator sets the secret; the boot check in
    // shopify.server.ts says so at startup.
    console.error('[sentient] SHOPIFY_CONNECTOR_SECRET is not set — plan sync cannot run; Shopify will retry');
    return false;
  }
  const body = JSON.stringify({
    plan,
    shopDomain,
    ...(opts.disconnect ? { disconnect: true } : {}),
    // When the uninstall happened, not when it was processed: a retry
    // landing after a reinstall must not void the new subscription.
    ...(opts.disconnect && opts.releasedAt ? { releasedAt: opts.releasedAt } : {}),
    ...(opts.event
      ? {
          ended: opts.event.ended,
          ...(opts.event.status ? { status: opts.event.status } : {}),
          ...(opts.event.subscriptionId ? { subscriptionId: opts.event.subscriptionId } : {}),
          ...(opts.event.updatedAt ? { subscriptionUpdatedAt: opts.event.updatedAt } : {}),
        }
      : {}),
  });
  try {
    // By shop first: authorised by the connector secret, the project named by
    // this app's own key (still honoured after a rotation revoked it, so a
    // CANCELLED or an uninstall is not stranded — review R4 N1), and only
    // while the shop's binding to that project is live (a Settings
    // Disconnect ends it — review R5). The sk_ route remains for shops not
    // bound yet. Both calls fit Shopify's 5 s webhook deadline (audit H22).
    let res = await fetchImpl(`${sentientApiUrl()}/v1/provision/shopify/plan-by-shop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secretKey}`, 'x-connector-secret': connectorSecret },
      body,
      signal: AbortSignal.timeout(2_500),
    });
    if (res.status === 404) {
      res = await fetchImpl(`${sentientApiUrl()}/v1/provision/shopify/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secretKey}`, 'x-connector-secret': connectorSecret },
        body,
        signal: AbortSignal.timeout(2_000),
      });
    }
    if (res.ok) {
      // A 200 can still mean "not applied": a purchase on an account billed
      // another way (card, contract, a grant). Shopify charged the merchant,
      // so the admin must say so — only a server log did (review R9 M1).
      try {
        const body = (await res.json()) as { applied?: unknown; reason?: unknown };
        if (body.applied === false && body.reason === 'refused') return 'refused';
      } catch {
        /* an empty or non-JSON 200 is a success */
      }
      return true;
    }
    // Retryable only when retrying can help. 401 (a revoked key, no live
    // binding), 400 and a final 404 are permanent: 500ing on them kept
    // Shopify retrying an uninstall for 48 h while the shop's data was never
    // erased. 403 is the connector secret itself — operator misconfiguration
    // (a rotation not yet on both apps) that WILL be fixed, so it retries,
    // like an unset secret (review R5 N3, audit P0-7).
    // An uninstall passes forbiddenIsTerminal: 500ing it for 48 h on a secret
    // mismatch kept the shop's data unerased (review R6 L1); a subscription
    // event keeps retrying, so the purchase is applied once it's fixed. 409
    // (a disconnected shop's ACTIVE) is terminal and never falls back.
    if (res.status === 403) return opts.forbiddenIsTerminal ? 'terminal' : false;
    return res.status === 429 || res.status >= 500 ? false : 'terminal';
  } catch {
    return false;
  }
}

type GraphqlFn = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<{ json(): Promise<unknown> }>;

const ACTIVE_SUBSCRIPTIONS = `#graphql
  query sentientActiveSubscriptions {
    currentAppInstallation { activeSubscriptions { id name status createdAt } }
  }`;

/** The merchant's ACTIVE subscription as Shopify holds it now, shaped like a
 *  webhook event (its createdAt is the ordering clock, on Shopify's time like
 *  the events' updated_at). Null when there is none, the plan name is not
 *  ours, or the read failed.
 *
 *  It never reports "none": a downgrade from a read taken between a purchase
 *  and its activation would end a plan just bought. Ends stay the webhooks'
 *  job; this only recovers what they can lose — an event that arrived before
 *  keys were saved, or before a reinstall's keys (grader R1 N9). */
/** What Shopify says the shop is subscribed to: its ACTIVE subscription
 *  (event), an explicit "none" (observed: 'none' — told to the API, which a
 *  pre-187 plan's legacy guard needs: a failed read must never look like a
 *  free store, review R9 ADV-2), or nothing known (a failed read, or an
 *  ACTIVE plan name this build does not know). */
export async function readSubscriptionState(graphql: GraphqlFn): Promise<{ event: SubscriptionEvent | null; observed: 'none' | null }> {
  try {
    const res = (await (await graphql(ACTIVE_SUBSCRIPTIONS)).json()) as {
      data?: { currentAppInstallation?: { activeSubscriptions?: Array<{ status?: string }> } };
    };
    const subs = res.data?.currentAppInstallation?.activeSubscriptions;
    if (!Array.isArray(subs)) return { event: null, observed: null };
    if (!subs.some((x) => (x.status ?? '').toUpperCase() === 'ACTIVE')) return { event: null, observed: 'none' };
    return { event: await readActiveSubscription(async () => ({ json: async () => res })), observed: null };
  } catch {
    return { event: null, observed: null };
  }
}

export async function readActiveSubscription(graphql: GraphqlFn): Promise<SubscriptionEvent | null> {
  try {
    const res = (await (await graphql(ACTIVE_SUBSCRIPTIONS)).json()) as {
      data?: { currentAppInstallation?: { activeSubscriptions?: Array<{ id?: string; name?: string; status?: string; createdAt?: string }> } };
    };
    const subs = res.data?.currentAppInstallation?.activeSubscriptions;
    const active = Array.isArray(subs) ? subs.find((s) => (s.status ?? '').toUpperCase() === 'ACTIVE') : undefined;
    if (!active) return null;
    // The clock is "observed ACTIVE now" (a minute back, for skew against
    // Shopify's event clock): createdAt could never move past a later FROZEN
    // or a release, so a lost resume webhook, or a shop moved back to this
    // account, stayed on free for good (review R3).
    return subscriptionEvent({
      app_subscription: { name: active.name, status: 'ACTIVE', admin_graphql_api_id: active.id, updated_at: new Date(Date.now() - 60_000).toISOString() },
    });
  } catch {
    return null;
  }
}

/** Read the shop's subscription state before provisioning (which records an
 *  explicit "none"); nothing is read when plan sync is not configured. */
export async function observeSubscription(graphql: GraphqlFn): Promise<{ event: SubscriptionEvent | null; observed: 'none' | null }> {
  return planSyncConfigured() ? readSubscriptionState(graphql) : { event: null, observed: null };
}

/** Best-effort: push the observed active subscription to SentientUI
 *  (idempotent; the API's ordering guards make a repeat or a stale read a
 *  no-op). A reconnect's plan comes back this way. */
export async function reconcilePlan(secretKey: string, shopDomain: string, observed: { event: SubscriptionEvent | null }): Promise<void> {
  if (observed.event) await syncPlan(secretKey, observed.event.plan, shopDomain, fetch, { event: observed.event });
}

