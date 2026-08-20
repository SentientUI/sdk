// SentientUI web pixel (spec §3): fires the upstream funnel steps as plain
// goals, binds the checkout token to the visitor session at checkout_started
// (POST /v1/attributions — read later by /v1/conversions attribution), and
// captures checkout_completed as the fast browser path. The orders/paid
// webhook is the truth path; the external_id unique makes the pair converge
// (whichever lands second no-ops).
//
// Origin note: web-pixel sandbox requests may carry a sandbox Origin. If the
// dev-store verification finds the shop domain missing from the request
// Origin, route these two calls through the app proxy (backend forwards with
// sk_, which bypasses Origin by design) — do NOT weaken requireOrigin on the
// API (plan Task 4).
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

  const sid = () => browser.cookie.get('_snt_uid');
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

  // Fast path: browser capture. The webhook is the truth path; the
  // external_id unique makes the pair converge (whichever lands second no-ops).
  analytics.subscribe('checkout_completed', (event) => {
    const c = event.data.checkout;
    if (!c) return;
    void goal('purchase', {
      value: Number(c.totalPrice?.amount ?? 0) || undefined,
      currency: c.currencyCode ?? undefined,
      externalId: String(c.order?.id ?? c.token ?? ''),
    });
  });
});
