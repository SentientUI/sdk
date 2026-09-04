// SentientUI web pixel (spec §3): fires the upstream funnel steps as plain
// goals, binds the checkout token to the visitor session at checkout_started
// (POST /v1/attributions — read later by /v1/conversions attribution), and
// captures checkout_completed as the fast browser path. The orders/paid
// webhook is the truth path; the external_id unique makes the pair converge
// (whichever lands second no-ops).
//
// Origin: verified live (README dev-store checklist, 2026-08-29) — the
// sandboxed pixel's requests pass the API's requireOrigin check as-is, so no
// app-proxy detour is needed (and requireOrigin must not be weakened).
import { register } from '@shopify/web-pixels-extension';

register(({ analytics, browser, settings }) => {
  const api = settings.apiBase ?? 'https://api.sentient-ui.com';
  const post = (path: string, body: unknown) =>
    fetch(`${api}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.publishableKey}` },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => undefined); // pixel must never break checkout

  // The snippet namespaces its visitor cookie per project — `_snt_uid` plus
  // `_${apiKey.slice(0, 12)}` (core storage-key.ts) — so multiple projects on
  // one origin can't share a session. Reproduce that name from the pixel's own
  // publishableKey; fall back to the bare name (explicit cookieName installs).
  const key = String(settings.publishableKey ?? '');
  const sid = async () =>
    (key ? await browser.cookie.get(`_snt_uid_${key.slice(0, 12)}`) : undefined) ||
    (await browser.cookie.get('_snt_uid'));
  const goal = async (name: string, extra: Record<string, unknown> = {}) => {
    const sessionId = await sid();
    if (!sessionId) return;
    void post('/v1/goals', { sessionId, name, goalId: crypto.randomUUID(), ...extra });
  };

  // Upstream funnel steps as plain goals (spec §3: the pixel fires them).
  analytics.subscribe('product_viewed', () => void goal('product_viewed'));

  analytics.subscribe('checkout_started', async (event) => {
    const sessionId = await sid();
    const token = event.data.checkout?.token;
    if (sessionId && token) void post('/v1/attributions', { sessionId, token });
    void goal('checkout_started');
  });

  // Fast path: browser capture. The webhook is the truth path; the pair only
  // converges because dedupe is an EXACT string match on (project, goal,
  // external_id), and the webhook side sends the numeric REST order id
  // (orderPaidToConversion: String(order.id)). Two ways this used to diverge
  // and double-count / drop:
  //  - the pixel's order id can be gid-formatted ("gid://shopify/Order/123")
  //    where the webhook sends "123" — normalize to the trailing digits;
  //  - on wallet/deferred checkouts `checkout.order` is null here. Falling
  //    back to the checkout token recorded the purchase under a key the
  //    webhook never sends → the same order counted twice; and with token
  //    also absent, externalId "" failed the API's min-length validation and
  //    the goal was silently 400-dropped. In either case there is no id the
  //    webhook will match, so SKIP the fast path and let the webhook be the
  //    sole writer of the purchase goal.
  analytics.subscribe('checkout_completed', (event) => {
    const c = event.data.checkout;
    if (!c) return;
    // Trailing digits of the id, ignoring any gid query string
    // ("gid://shopify/Order/123?key=abc" → "123"; "123" → "123").
    const orderId = c.order?.id == null ? undefined : /\d+$/.exec(String(c.order.id).split('?')[0])?.[0];
    if (!orderId) return; // no real order id → webhook is the sole writer
    void goal('purchase', {
      value: Number(c.totalPrice?.amount ?? 0) || undefined,
      currency: c.currencyCode ?? undefined,
      externalId: orderId,
    });
  });
});
