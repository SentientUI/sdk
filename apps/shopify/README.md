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

## Status: in review — three rejections fixed

- **Round 1 (2026-09-06):** missing test credentials (4.5.4 — the review
  account existed but held no project) + billing wording read as mandatory
  off-platform billing (1.2.1/1.2.2). Fixed: keys inline in the review
  instructions, free-plan-first copy.
- **Round 2 (2026-09-09, ref 133916):** subscription must go through
  Shopify billing (now App Pricing — see "Pricing and billing") and a
  real pixel bug: `ensureWebPixel`'s lookup-first order treated the thrown
  "No web pixel was found for this app." as fatal, so FRESH stores never
  created the pixel (dev stores masked it — their pixel pre-existed).
- **Round 3 (2026-09-21):** two findings, both of which this repo had
  recorded as DONE while they were not.
  - *1.2.1, subscribing 404s.* The four plans existed only under **"Manual
    pricing (legacy)"** — App Store listing copy that charges nothing.
    Shopify App Pricing itself was never enabled (the migration wizard still
    read "App Pricing enabled — not started"), and
    `/charges/<handle>/pricing_plans` does not exist until it is. Enabled
    2026-09-22; the four App Pricing plans were already drafted and their
    handles already matched `PLAN_NAME_MAP`, so nothing else moved. The app
    handle in the link (`sentientui-app`) was correct all along — the 404 was
    the missing switch, not the handle.
  - *5.1.2, every storefront request 403s.* `origin_not_allowed` is the only
    403 `/v1/sessions`, `/v1/decide` and `/v1/events` can return, and the
    shop's origin is only allowlisted when the merchant presses "Save and
    connect". The theme embed is a separate surface with its own pasted pk_,
    so it can be enabled and configured with no allowlisting having happened
    — and nothing anywhere said so. Fixed by re-affirming the origins on
    every admin page view and by showing the result: see "Storefront
    reachability" below.

Every checklist item below passed live on `sentientui-store.myshopify.com`,
including the pixel path and the three-step checkout funnel, and the backend
now runs at `connect.sentient-ui.com` (a CNAME to `sentientui-shopify.fly.dev`; see "Deploying to production").

**Before submission.** The mandatory GDPR compliance webhooks
(`customers/data_request`, `customers/redact`, `shop/redact`) are declared in
`shopify.app.toml` and handled in `app/routes/webhooks.customers.*.tsx` /
`webhooks.shop.redact.tsx`; paid plans are sold through Shopify App Pricing and
the free plan covers everything the app sets up (see "Pricing and billing"); the
template's demo page is gone from the merchant nav.
What is left is **operator work, not code**:

- **Re-confirm the protected-customer-data declaration.** Granted for
  development; review evaluates it again at submission.
- ~~**Set `SETTINGS_ENCRYPTION_KEY`**~~ — set on Fly (verified 2026-09-05,
  `fly secrets list`); stored rows convert themselves as merchants save.
- **Fill the listing** from `listing/LISTING.md` — copy, URLs, review
  instructions, and the screenshot/screencast plan are pre-written there;
  the 1200×1200 icon is `listing/icon-1200.png`.
- ~~**Configure the pricing plans**~~ — the four plans exist and their
  handles match PLAN_NAME_MAP in `app/lib/plan-sync.server.ts`, and
  **Shopify App Pricing is ENABLED** (2026-09-22). Verified live:
  `https://admin.shopify.com/store/sentientui-store/charges/sentientui-app/pricing_plans`
  renders "Select a plan" with all four. Drafting plans is NOT the same as
  enabling App Pricing — the plans sat in "Manual pricing (legacy)" for two
  review rounds while that link 404'd.
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

## Storefront reachability — why the 403s were invisible

`requireAuth` in the API refuses a `pk_` request whose `Origin` is not in the
project's `allowed_origins`, and `origin_not_allowed` is the ONLY 403
`/v1/sessions`, `/v1/decide` and `/v1/events` can return. So a storefront on
an unallowed domain fails completely and silently: no error in the theme, no
error in this app, just a dashboard that never fills up. The App Store
rejected the app for it (5.1.2, round 3).

Three things now stand between a merchant and that silence:

1. **Allowlisting is re-affirmed on every admin page view**, not only on
   "Save and connect" (`app/routes/app._index.tsx` loader). Saving was a
   single point of failure: enable the theme embed without ever visiting
   this screen, reinstall against the empty production database, or add a
   custom primary domain, and the allowlist no longer covers the domain
   visitors actually use.
2. **The screen says whether the storefront is accepted** — a red banner
   naming the domain when it is not, a green one when it is.
   `checkStorefrontOrigin` (`app/lib/settings.server.ts`) asks
   `GET /v1/origin-check`, which runs the same `requireAuth` check with no
   side effects, forging the shop's `Origin` from the server.
3. The check uses the key **saved in this app**. The theme embed carries its
   own pasted copy, so the green banner also reminds the merchant the two
   must match — a mismatch allowlists the wrong project and looks identical
   from here.

Known gap, deliberately not fixed here: the API caches auth records
(`allowed_origins` included) for 30s per instance, and `clearKeyCache()` only
clears the instance that handled the write. A storefront view in the seconds
right after a save can still be refused by another machine. Bounded by the
TTL and self-healing; closing it properly needs a shared invalidation channel.

## Webhooks and the dead offline token

`@shopify/shopify-app-remix` runs `ensureValidOfflineSession` on EVERY webhook,
GDPR compliance topics included. With `expiringOfflineAccessTokens` enabled
(`app/shopify.server.ts`), an offline token within five minutes of expiry makes
it call Shopify's token endpoint, and the library's `refresh-token` helper
throws a hardcoded **500 Internal Server Error** when that call fails.

For an uninstalled or closed store that refresh can never succeed, so the
topics that fire *after* the shop is gone — `app/uninstalled` and the three
GDPR ones — 500 inside authentication, before a line of handler code runs, and
Shopify retries them for 48h against something permanent.

That is the 2026-09-21 incident: `app/uninstalled` at a 90% failure rate and
`shop/redact` at 100%, every failure the same closed review store, while a
different shop's uninstall succeeded in the middle of the same window (which is
what ruled out an outage). The failure rate was the visible part; the damage
was that **the erasure those webhooks exist to perform never happened**.

Those four routes therefore use
`authenticateWebhookAllowingExpiredToken` (`app/lib/webhook-auth.server.ts`)
instead of `authenticate.webhook`. It delegates first, and only when
authentication fails for a reason that is *not* a rejection of the request
(400/401/405) does it verify the HMAC itself and carry on with no session —
which those handlers never used. **The HMAC is the gate**: a forged request
fails it and the original error is rethrown, so nothing is widened.

Leave the revenue topics on plain `authenticate.webhook`; they only fire for a
live shop, and they want the session.

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
   `connect.sentient-ui.com` (CNAME to `sentientui-shopify.fly.dev`; review
   rejects "shopify" in the app's domain), `automatically_update_urls_on_dev = false`
   (so a stray `shopify app dev` cannot overwrite the prod URLs), and
   `redirect_urls` lists `<url>/auth/callback` + `<url>/auth/login` — these
   must match `authPathPrefix` in `app/shopify.server.ts`, NOT the template's
   `/api/auth`, or any fallback to classic OAuth fails as
   "redirect_uri is not whitelisted".
2. `shopify app deploy` from `apps/shopify/` — this releases the extensions
   (theme embed + web pixel) and the toml config (scopes, webhook
   subscriptions) as one app version. Webhook URIs are relative, so they
   follow `application_url` automatically.

### Release order (this branch's changes)

0. Before deploying the API, list every Shopify-billed paid account — all of
   them are pre-187 (no subscription rows yet), and the legacy-plan rule above
   finds their paying store through its allowlisted myshopify origin, which a
   store whose keys were saved before 2026-09-06 and whose plan was bought
   before 2026-09-21 without re-saving does not have. Check each has one
   origin per Shopify store it runs; for any that does not, have the merchant
   open the app once after deploy (provision + reconcile write their rows)
   before anything else touches the account:
   ```sql
   SELECT u.id, u.plan, array_agg(o) FILTER (WHERE o LIKE 'https://%.myshopify.com') AS shop_origins
     FROM users u LEFT JOIN projects p ON p.user_id = u.id LEFT JOIN LATERAL unnest(p.allowed_origins) o ON TRUE
    WHERE u.billing_source = 'shopify' AND u.plan IN ('starter','growth','scale')
    GROUP BY u.id, u.plan;
   ```
1. API with migrations 187 and 188 (`release_command` migrates before boot; the
   boot check refuses an image whose migrations are unapplied) — the new
   `/v1/provision/shopify/customer` route and plan-sync fields must exist
   before an app build calls them, or the GDPR webhooks 500 until it does.
2. Dashboard (`/connect/shopify`, `/r/` reports, Settings → Connected Shopify
   stores) — BEFORE the Fly app, whose settings screen shows "Connect with
   SentientUI": deployed first, that button led to a 404 (review R3 N6).
3. Publish `@sentientui/snippet` 0.32 to npm — the embed's
   `consentFrom:"shopify"` is ignored by 0.31.x.
4. The Fly app (`SHOPIFY_APP_URL`, reconcile, metafield owner move) and
   `shopify app deploy` (the theme embed's key fallback) together: the
   settings screen stops asking for the second pk_ paste only when the embed
   can read it. Not during an App Store review window.
5. Merchants' next admin visit re-writes the app-data metafields; the old
   shop-owned mapping is shown in the settings box until they save.
6. `listing/LISTING.md` bullet 4 (Results card) and a zero-key bullet 1
   describe this release — resubmit the listing copy only after it is live.

**Customer data requests** are recorded in the project's audit log
(`gdpr.customer_data_request`, with the orders held) — an operator must send
them to the store owner within 30 days. `shop/redact` erases this app's rows;
the merchant's SentientUI project (theirs, on their own account) is left alone
by design — deleting it is the merchant's call from the dashboard. So are the
API's billing records for the shop (its connection to the project and its
Shopify subscription history), which the account's plan is derived from.

**Zero-key connect (audit H11).** "Connect with SentientUI" signs `{shop,
exp, n}` with `SHOPIFY_CONNECTOR_SECRET` and sends the merchant to
`${SENTIENT_DASHBOARD_URL:-https://sentient-ui.com}/connect/shopify`. There the
signed-in user picks or creates a project; the API (`POST
/v1/mgmt/shopify/connect`) verifies the state, mints an ADDITIONAL pk_ + sk_
(nothing rotated) and POSTs them to this app's `/connect/callback`, which only
HOLDS them (`PendingConnect`, Prisma migration `20260925120000`). The merchant
confirms in the embedded admin, which runs the normal save. The API needs
`SHOPIFY_APP_URL` (default `https://connect.sentient-ui.com`) and the same
`SHOPIFY_CONNECTOR_SECRET`; undelivered keys are revoked. Manual paste stays as
the fallback.

### 3. Before App Store submission (not needed for custom installs)

- Billing: decided — Shopify App Pricing (Managed Pricing) for Shopify
  merchants, never Stripe. See "Pricing and billing".
- Protected customer data: the self-serve declaration made for dev gets
  human review at submission; the app requests order data only, no PII
  fields, which is the cheapest tier to defend.
- The listing needs privacy policy + support URLs in the Partner dashboard.

### Post-release gotchas (both hit live on 2026-08-29)

- **Ending the dev preview deactivates the theme embed.** The embed
  enablement recorded while `shopify app dev` previewed the app does not
  carry over to the released version — after the first `shopify app
  deploy` (and `shopify app dev clean` for a stuck preview), re-enable
  the embed in the theme editor (the pk comes from the app's saved keys via
  the `config.publishable_key` app-data metafield; a pk typed into the embed
  still overrides it). Deploy the Fly app and the extension together: the
  settings screen no longer asks for a second paste. The web pixel is
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

## Pricing and billing — Shopify App Pricing (enabled 2026-09-22)

**The app is free to install; paid plans are Shopify App Pricing.**

Three review rejections got us here: round 1 (2026-09-06) killed wording that
framed the SentientUI service as paid-and-required with an external billing
link; round 2 (2026-09-09, ref 133916) ruled that even the OPTIONAL Stripe
subscription must go through Shopify once reviewers could see it in the
dashboard; round 3 (2026-09-21) found that the plans had been described but
never actually switched on. So for Shopify-installed merchants, Shopify
billing REPLACES Stripe (never alongside — nobody pays on two rails):

- Plans (Free $0 default, Starter/Growth/Scale flat monthly) are configured
  as App Pricing in the Partner dashboard. Their NAMES are a contract
  with `app/lib/plan-sync.server.ts` (PLAN_NAME_MAP).
- **Drafting plans is not enabling App Pricing.** Both steps of the migration
  wizard must be green. Until the second one is, the plans render on the App
  Store listing and `/charges/<handle>/pricing_plans` 404s — which reads to a
  reviewer as an app that cannot be paid for.
- The rail is claimed when a store **connects**, not when a plan is bought:
  `/v1/provision/shopify` sets `users.billing_source = 'shopify'` for free
  accounts. Claiming it only at purchase left every free Shopify merchant —
  which is exactly what a reviewer is — looking at the dashboard's Stripe
  upgrade button, and that is what round 3 flagged as off-platform billing.
  Uninstall releases THAT shop's subscriptions (`disconnect: true` on the plan
  sync, as of the uninstall's triggered-at) and hands the rail back only when
  no other shop of the account still has live history; a mere cancellation
  keeps the rail, because that merchant can still re-subscribe through
  Shopify.
- The `app_subscriptions/update` webhook maps the subscription to a
  SentientUI plan and syncs it via `POST /v1/provision/shopify/plan-by-shop`
  (connector secret + the shop's sk_, which names the project even after a
  rotation revoked it; the shop's binding to that project must be live), or
  `POST /v1/provision/shopify/plan` for a shop not bound yet. Never by the sk_
  alone — any sk_ holder could self-upgrade. Each subscription keeps its own
  state and the plan is derived (the latest ACTIVE per shop, the highest
  across shops), so delivery order does not matter.
- Settings → Connected Shopify stores → Disconnect cuts a shop from a project
  (connected either way — zero-key, or pasted keys, listed by domain): its
  binding is marked disconnected and its subscriptions stop counting (not
  while the owner reaches the shop through another project), then its connect
  keys are revoked. The shop can still LOWER the plan (a cancellation in
  Shopify, an uninstall) but an ACTIVE is refused with 409, which the app
  treats as final. Only a key created after the disconnect re-binds the shop,
  its plan restored by the reconcile that follows (Shopify's own ACTIVE) —
  never by a marker a lost webhook could leave stale. The app shows a disconnected store as such
  (provision reports `binding`), and a plan change SentientUI refuses lands in
  the admin's drop banner. Billing continues in Shopify until the merchant
  cancels there. Deleting a project cuts its shops the same way, first.
- A shop has one live binding: connecting it to another project detaches the
  old one (cutting it from another account if it moved), and an uninstall
  detaches it. A connect re-attaches an uninstalled binding; a moved one needs
  a key created after the move. When nothing on Shopify funds an account any
  more — no live store and no counted live subscription — it returns to free
  and card billing. A plan set before migration 187 (no subscription ever
  active in the rows) ends only once no store could still be paying for it: no
  live store whose subscriptions were never read from Shopify and found empty
  (the app reports that read on provision), and no myshopify origin on the
  account whose store is unaccounted for. Comps and contract plans are never
  changed by a Shopify event.
- A binding the shop moved away from is treated like a disconnected one: it
  can only lower a plan. A cancellation ends the subscription on every
  account still counting it, and an uninstall releases the account the shop
  is live on whichever key delivered it. The app refuses to save a pasted key
  whose store comes back disconnected — and, when replacing stored keys, any
  answer that does not confirm the store live (a timeout keeps the current
  keys). A plan change SentientUI refuses (the account is billed another way,
  or the store is disconnected) is shown in its own admin banner
  (`planIssueAt`, Prisma migration `20260925140000`) until a later plan event
  applies — orders flowing again do not clear it.
- Provisioning records the binding in one transaction on one connection,
  serialised per shop, and only if the binding is still what it read (a
  Disconnect committing mid-provision wins). If that step fails the API
  answers 503 and writes nothing.
- Rotating keys in the dashboard does not disconnect a store: its plan events
  still reach the account (the connector secret, not the key, is the proof).
  Use Disconnect for that.
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
