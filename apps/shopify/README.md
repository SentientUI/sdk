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

## Status: in review — two rejections fixed, Managed Pricing shipped

- **Round 1 (2026-09-06):** missing test credentials (4.5.4 — the review
  account existed but held no project) + billing wording read as mandatory
  off-platform billing (1.2.1/1.2.2). Fixed: keys inline in the review
  instructions, free-plan-first copy.
- **Round 2 (2026-09-09, ref 133916):** subscription must go through
  Shopify billing (now Managed Pricing — see "Pricing and billing") and a
  real pixel bug: `ensureWebPixel`'s lookup-first order treated the thrown
  "No web pixel was found for this app." as fatal, so FRESH stores never
  created the pixel (dev stores masked it — their pixel pre-existed).

Every checklist item below passed live on `sentientui-store.myshopify.com`,
including the pixel path and the three-step checkout funnel, and the backend
now runs at `sentientui-shopify.fly.dev` (see "Deploying to production").

**Before submission.** The mandatory GDPR compliance webhooks
(`customers/data_request`, `customers/redact`, `shop/redact`) are declared in
`shopify.app.toml` and handled in `app/routes/webhooks.customers.*.tsx` /
`webhooks.shop.redact.tsx`; the app is free and requests no Shopify charge (see
"Pricing and billing"); the template's demo page is gone from the merchant nav.
What is left is **operator work, not code**:

- **Re-confirm the protected-customer-data declaration.** Granted for
  development; review evaluates it again at submission.
- ~~**Set `SETTINGS_ENCRYPTION_KEY`**~~ — set on Fly (verified 2026-09-05,
  `fly secrets list`); stored rows convert themselves as merchants save.
- **Fill the listing** from `listing/LISTING.md` — copy, URLs, review
  instructions, and the screenshot/screencast plan are pre-written there;
  the 1200×1200 icon is `listing/icon-1200.png`.
- **Configure Managed Pricing plans** in the Partner dashboard (Free $0
  default + Starter/Growth/Scale) with names matching PLAN_NAME_MAP in
  `app/lib/plan-sync.server.ts` — see "Pricing and billing" below.
- **Set `SHOPIFY_CONNECTOR_SECRET`** (same value on `sentient-api` and
  `sentientui-shopify` via `fly secrets set`) — without it the plan sync is
  disabled and the API refuses plan writes (fail closed).

The operator ran `shopify app init` (Partner org `sentientui-app`,
client_id in `shopify.app.toml`) and the generated Remix shell is merged in:
template auth plumbing, Prisma session storage, embedded admin, plus —

- `app/lib/sentient.ts` — pure webhook→request mappers (vitest-covered).
- `app/lib/forward.ts` — the forwarding core with the retry contract
  (vitest-covered): non-2xx/unreachable SentientUI → 500 → Shopify retries
  48h; unconfigured shop or unknown topic → 200 (retrying can't help).
- `app/lib/settings.server.ts` + `app/routes/app._index.tsx` — the settings
  screen: per-shop `pk_`/`sk_` in Prisma (`SentientSettings`; sk_ never echoed
  to the client), `POST /v1/provision/shopify` on save, and a theme-editor
  deep link to enable the app embed.
- `app/routes/webhooks.orders.paid.tsx` / `webhooks.refunds.create.tsx` —
  HMAC via `authenticate.webhook`, then `forwardWebhook`. Subscriptions and
  the `read_orders` scope live in `shopify.app.toml`.
- `extensions/theme-embed/` — the app-embed block (the snippet one-liner,
  mirroring the dashboard's canonical Shopify install; SRI deliberately absent
  — first-party self-updating snippet, a pinned hash would break releases).
- `extensions/checkout-pixel/` — the web pixel source (excluded from this
  package's tsc — extensions build with the Shopify CLI's own toolchain).

Uninstall deletes the shop's sessions AND its stored SentientUI keys.

## Operator steps — done (kept for the record)

1. ~~`shopify app dev` against a free development store~~ — done; checklist
   below all passed. Known wrinkle to watch on fresh installs: newer
   `@shopify/shopify-api` than `shopify-app-session-storage-prisma@8`
   declares (peer warnings; typecheck/tests pass) — if dev-store auth
   misbehaves, align those two versions first.
2. ~~**Protected customer data access**~~ — granted (Partner dashboard →
   Apps → sentientui-app → API access; the menu only appears AFTER a
   distribution method is selected). Shopify refuses to even REGISTER the
   orders/refunds webhook subscriptions until the app declares this. The
   app requests order data only — do NOT request the optional PII fields
   (name/email/address/phone); the forwarders only use order id, total,
   currency and cart/checkout tokens. Effective immediately for
   development; App Store review evaluates it at submission.
3. Deploy — see "Deploying to production" below (never via CI — deliberate).

## Dev-store verification checklist — RUN 2026-08-29 (sentientui-store.myshopify.com)

- [x] Install on a dev store; enable the theme embed with the project's pk_;
      confirm the snippet boots and a session appears in the dashboard.
      **PASS**: embedded settings screen rendered, keys saved, snippet booted
      on the storefront (decide succeeded — snapshot written), Origin check
      passed with the myshopify domain in `allowed_origins`.
- [x] Provisioning: `POST /v1/provision/shopify` created the `purchase` goal
      (main) + `checkout` funnel. (Two live bugs found and fixed during this
      run: empty-JSON-body 400 on the provision call; offset timestamps 400ing
      `/v1/conversions` — see git history.)
- [x] Test order end-to-end: order #1001 ($32.95 incl. shipping, Bogus
      Gateway) → `orders/paid` webhook → dashboard shows **ONE** conversion
      with the server total US$32.95.
- [x] Refund the test order → revenue netted to US$0.00 on the goals page
      within a minute (hit count preserved — the trial still counts).
- [x] **Pixel path** (fast browser path): the app now activates its own web
      pixel on settings save (`ensureWebPixel`; needed BOTH `write_pixels`
      and `read_customer_events` scopes — the live error said so). Verified
      with order #1002 ($32.95): `product_viewed` and `checkout_started`
      goals fired, and the purchase landed in the SAME session — so the
      pixel's namespaced cookie (`_snt_uid_` + pk prefix) matched the
      snippet's, and the sandboxed pixel's requests passed `requireOrigin`
      as-is (no app-proxy detour needed; do NOT weaken `requireOrigin`).
- [x] Funnel `checkout` three-step view: report shows all three steps reached
      by one session, zero drop-off, US$32.95 revenue on the final step.

## Deploying to production (operator-run, never CI)

Two independent halves. Order matters: host the backend first, because
`shopify app deploy` pushes config that points Shopify at the hosted URL.

**Done 2026-08-31.** The app runs on Postgres: a `sentientui_shopify` database
and user inside the EXISTING `sentient-db` cluster, not a dedicated one. Sharing
the cluster avoids a second always-on Postgres for an app this small; the cost
is a shared blast radius with the API, which is the trade to revisit if the
Shopify side ever carries real load.

```sh
fly postgres attach sentient-db -a sentientui-shopify   # injects DATABASE_URL
fly secrets set SETTINGS_ENCRYPTION_KEY="$(openssl rand -base64 32)" -a sentientui-shopify
```

`npm run setup` runs `prisma migrate deploy` on every boot, so the schema
applies itself — `20260830204544_init_postgres` applied on the first boot.

**Two things `fly postgres attach` does that are worth knowing before you run
it again.** It prints the full `DATABASE_URL`, password included, to stdout — so
never run it where the output is captured or shared, and rotate with
`fly postgres detach` + re-attach if it lands somewhere it should not. And it
sets the secret and restarts IMMEDIATELY, with no `--stage` flag: on an app
still running a SQLite build that is a crashloop, because Fly secrets override
`[env]` and Prisma's SQLite connector rejects a `postgres://` URL. Build and
push the Postgres image FIRST (`fly deploy --build-only --push`), then attach,
then release the pre-built image.

### 1. Host the Remix backend

Any Node 22 host works; the `Dockerfile` builds a self-contained image
**from `apps/shopify/` as the context** (the app has no `workspace:*` deps,
so it installs standalone with npm — the monorepo lockfile doesn't apply):

```bash
cd apps/shopify
docker build -t sentientui-shopify .
```

Runtime contract:

- **Env vars**: `SHOPIFY_API_KEY` (client_id from `shopify.app.toml`),
  `SHOPIFY_API_SECRET` (Partner dashboard → app → "Client secret"),
  `SHOPIFY_APP_URL` (the public https URL of this backend),
  `SCOPES=read_orders,write_pixels,read_customer_events` (must match the
  toml), `SETTINGS_ENCRYPTION_KEY` (any passphrase ≥16 chars, via
  `fly secrets set` — envelopes the stored `sk_`; ABSENT means plaintext, which
  is a silent downgrade, so set it). Optional: `SENTIENT_API_URL` (defaults to
  the prod API).
- **Health check**: `GET /healthz` does a real database round trip and Fly polls
  it every 30s, so a wedged process leaves rotation instead of serving errors.
- **Persistence**: Postgres. Sessions and per-shop `pk_`/`sk_` live there, so
  machines are interchangeable and a deploy is a rolling replace rather than
  downtime. Attach it with `fly postgres attach`, which injects `DATABASE_URL`
  as a secret — do not put it in `fly.toml [env]`.

  This was SQLite on a mounted volume until 2026-08-30. The volume was what
  pinned the app to exactly one machine: every deploy was downtime for OAuth and
  the embedded admin, there was no replica, and losing the volume would have
  taken every merchant's stored keys with it. (It also had a trap: mounting the
  volume anywhere that shadowed `/app/prisma` hid `schema.prisma` from
  `migrate deploy` and crashlooped the machine — learned live on the first
  deploy. Nothing shadows anything now.)
- Boot runs `prisma migrate deploy` (via `docker-start`), so the schema
  applies itself on first start.

### 2. Point the app at the hosted URL and deploy

1. Already done in the committed toml: `application_url` points at
   `sentientui-shopify.fly.dev`, `automatically_update_urls_on_dev = false`
   (so a stray `shopify app dev` cannot overwrite the prod URLs), and
   `redirect_urls` lists `<url>/auth/callback` + `<url>/auth/login` — these
   must match `authPathPrefix` in `app/shopify.server.ts`, NOT the template's
   `/api/auth`, or any fallback to classic OAuth fails as
   "redirect_uri is not whitelisted".
2. `shopify app deploy` from `apps/shopify/` — this releases the extensions
   (theme embed + web pixel) and the toml config (scopes, webhook
   subscriptions) as one app version. Webhook URIs are relative, so they
   follow `application_url` automatically.

### 3. Before App Store submission (not needed for custom installs)

- Billing: decided — the app is free and carries no Shopify charge. See
  "Pricing and billing" for the reasoning and the review answer.
- Protected customer data: the self-serve declaration made for dev gets
  human review at submission; the app requests order data only, no PII
  fields, which is the cheapest tier to defend.
- The listing needs privacy policy + support URLs in the Partner dashboard.

### Post-release gotchas (both hit live on 2026-08-29)

- **Ending the dev preview deactivates the theme embed.** The embed
  enablement recorded while `shopify app dev` previewed the app does not
  carry over to the released version — after the first `shopify app
  deploy` (and `shopify app dev clean` for a stuck preview), re-enable
  the embed in the theme editor and re-enter the pk. The web pixel is
  unaffected: it's an API-created resource, not a theme setting.
- **The production database starts empty.** Keys saved during dev lived
  in a dev database and do not travel; the merchant must save keys once on the
  production app. If they rotate instead of copying, the theme embed's
  pk must be updated to match — the app backend and pixel pick up the
  new pair on save, but the embed's block setting does not.

### Sequencing note for Track B features

The theme embed loads `@sentientui/snippet` from unpkg, so storefronts get
the Composition Blocks renderer and section reordering only after the
pending changesets ship on the next SDK release train. Everything the app
itself carries (pixel, webhooks, provisioning, tag → persona mapping) is
live the moment the app version is released — no coupling between the two
deploys beyond that.

## Pricing and billing — Shopify Managed Pricing (since 2026-09-09)

**The app is free to install; paid plans are Shopify Managed Pricing.**

Two review rejections got us here: round 1 (2026-09-06) killed wording that
framed the SentientUI service as paid-and-required with an external billing
link; round 2 (2026-09-09, ref 133916) ruled that even the OPTIONAL Stripe
subscription must go through Shopify once reviewers could see it in the
dashboard. So for Shopify-installed merchants, Shopify billing REPLACES
Stripe (never alongside — nobody pays on two rails):

- Plans (Free $0 default, Starter/Growth/Scale flat monthly) are configured
  as Managed Pricing in the Partner dashboard. Their NAMES are a contract
  with `app/lib/plan-sync.server.ts` (PLAN_NAME_MAP).
- The `app_subscriptions/update` webhook maps the active subscription to a
  SentientUI plan and syncs it via `POST /v1/provision/shopify/plan` —
  authorized by the shop's sk_ PLUS `SHOPIFY_CONNECTOR_SECRET` (a Fly secret
  on both apps; the sk_ alone must never grant plan changes or any sk_
  holder could self-upgrade).
- The API marks such accounts `users.billing_source = 'shopify'`: the
  dashboard hides Stripe checkout for them (the API refuses it too), and a
  'free' sync (cancellation/uninstall) only downgrades accounts the Shopify
  rail owns — a Stripe-paying customer who merely uninstalls the connector
  keeps their plan.
- Uninstall releases the plan BEFORE deleting the shop's keys, because the
  CANCELLED webhook can land after the keys are gone.
- **Follow-up (post-approval):** the "Your plan" card shows the
  "upgrade through Shopify" link to every store, including ones connected to
  Stripe-paid or agency accounts. Harmless — such a purchase is refused at
  sync time (`applied: false`, audited) and unwound by support — but the
  polished version asks the API which rail owns the account and hides the
  link when the account isn't Shopify-billable.

This repo previously carried "$19 one-time (planned)" as an unmade decision,
and a charge was briefly implemented against it. It has been removed.

### How review actually ruled (rejection 2026-09-06)

The first submission was rejected on 1.2.1/1.2.2. The carve-out argument as
written above was never engaged with — what sank it was presentation: the
settings screen's "What this costs" card said the merchant pays for SentientUI
"priced on the traffic it optimizes" and linked to the external billing page,
and the free plan appeared only as a trailing aside. Review read that as a
*mandatory* service billed off-platform.

The load-bearing fact was missing: **the free plan is sufficient for
everything the app does.** Paid plans exist for traffic volume beyond the free
tier, extra seats, and AI features — optional upsells on the standalone
service, not a requirement of the app. The resubmission therefore leads with
free-plan-first wording everywhere (settings screen, listing, review
instructions) and keeps every billing/account link out of the app itself.

If Shopify ever rules that even the optional plans must go through them, the
change is to add a `billing` block in `app/shopify.server.ts` and a
`billing.require` in `app/routes/app.tsx` — but that should replace the Stripe
subscription for Shopify merchants, not sit alongside it.
