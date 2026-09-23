// Shopify Managed Pricing → SentientUI plan sync (App Store review round 2,
// 2026-09-09, ref 133916: "subscription charges must go through the Shopify
// billing API"). The merchant buys a plan on Shopify's hosted plan page; the
// app_subscriptions/update webhook lands here; the shop's stored sk_ plus the
// connector shared secret authorize the plan write on the SentientUI API.
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
  app_subscription?: { name?: string; status?: string } | null;
};

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
  opts: { disconnect?: boolean } = {},
): Promise<boolean> {
  const connectorSecret = process.env.SHOPIFY_CONNECTOR_SECRET;
  if (!connectorSecret) {
    // Fail loud in logs but soft to Shopify: without the secret the API
    // refuses the write, and retrying won't change that.
    console.error('[sentient] SHOPIFY_CONNECTOR_SECRET is not set — plan sync disabled');
    return true;
  }
  try {
    const res = await fetchImpl(`${sentientApiUrl()}/v1/provision/shopify/plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secretKey}`,
        'x-connector-secret': connectorSecret,
      },
      body: JSON.stringify(opts.disconnect ? { plan, shopDomain, disconnect: true } : { plan, shopDomain }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
