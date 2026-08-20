# @sentient/shopify — SentientUI Shopify app

> **Publicly mirrored:** `scripts/sync-public-sdk.sh` copies `app/`,
> `extensions/`, and the root config of this package into the open-source
> repo (github.com/SentientUI/sdk). Never put secrets, shop data, or `.env`
> content inside those subtrees.

The install IS the integration (spec:
`docs/superpowers/specs/2026-08-19-shopify-revenue-layer-design.md`): a theme
app embed carrying the snippet one-liner, a web pixel firing funnel-step goals
and the cart-token → session binding, and app-backend webhooks forwarding
server-truth orders/refunds to the SentientUI API.

## Status: partial scaffold — CLI init is an operator step

`shopify app init` (the Remix template) requires a Shopify **Partner login /
organization id even in non-interactive mode**, so the full app scaffold could
not be generated in-repo. What lives here now is everything that is testable
and read-verifiable without it:

- `app/lib/sentient.ts` — pure webhook→request mappers (vitest-covered).
- `extensions/theme-embed/` — the app-embed block (the snippet one-liner,
  mirroring the dashboard's canonical Shopify install; SRI deliberately absent
  — first-party self-updating snippet, a pinned hash would break releases).
- `extensions/checkout-pixel/` — the web pixel source.

## Operator: finishing the scaffold

1. In an interactive terminal (logged into the Partner org):
   `pnpm create @shopify/app@latest --template remix --name sentientui --package-manager pnpm`
   into a temp directory, then merge its generated app shell (Remix routes,
   Prisma session storage, `shopify.app.toml`, auth plumbing) into this
   package, keeping the files listed above.
2. **Settings screen** (embedded admin page, minimal): two fields —
   SentientUI **Publishable key** (`pk_…`) and **Secret key** (`sk_…`) —
   stored per shop in the template's Prisma session storage. On save, call
   `POST {SENTIENT_API_URL}/v1/provision/shopify` with
   `authorization: Bearer <sk_>`; surface success/failure. Link to the
   SentientUI dashboard — the merchant creates the project there first
   (open beta) and pastes the keys here.
3. **Webhook handlers** (`orders/paid`, `refunds/create`): keep the template's
   HMAC verification, then map with `orderPaidToConversion` /
   `refundCreateToRefund` (`app/lib/sentient.ts`) and POST to
   `/v1/conversions` / `/v1/refund` with the shop's stored sk_. A non-2xx
   from SentientUI → respond 500 so Shopify retries (48h).
4. Deploy with `shopify app deploy` (never via CI — deliberate).

## Dev-store verification checklist (record results in the PR)

- [ ] Install on a dev store; enable the theme embed with the project's pk_;
      confirm the snippet boots and a session appears in the dashboard.
- [ ] **Origin check probe:** from the pixel sandbox, confirm `/v1/goals` and
      `/v1/attributions` pass the project's Origin check with the shop domain
      in `allowed_origins`. If the sandboxed pixel's Origin is not the shop
      domain, route the pixel's two calls through the app proxy (backend
      forwards with sk_, which bypasses Origin by design) — do NOT weaken
      `requireOrigin` on the API.
- [ ] Test order end-to-end: pixel fires `purchase` → `orders/paid` webhook
      lands → dashboard shows ONE conversion with the server total; funnel
      `checkout` shows all three steps.
- [ ] Refund the test order → revenue nets down on the goals page;
      `refund_corrections` row processed within the hour.
