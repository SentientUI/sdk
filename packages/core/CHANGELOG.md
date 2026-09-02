# @sentientui/core

## 0.21.3

### Patch Changes

- 2f5d3ac: A repeat conversion is no longer swallowed in the browser. `goal()` collapses
  calls belonging to one user action, but it decided "one action" with a clock: a
  latch cleared on the next macrotask. A macrotask scheduled to close that window
  runs _after_ any timer already armed — which every real page has — so a second,
  genuinely separate conversion could land in a window that should have shut and
  be discarded before it ever reached the goal queue. Nothing was queued, so no
  retry, backoff or cross-reload bucket could rescue it: the order was gone
  client-side while the server was already prepared to record it (CONTRACTS §1,
  "two orders are worth two orders").

  The window is now the user action itself rather than an interval. Two nested
  components reacting to one click are exactly two listeners in one event
  dispatch, and `window.event` is the same Event object for every listener of a
  dispatch and a different object for the next click — so the collapse keys on
  that identity and cannot be jumped, however long the page stalls between two
  actions. Only a real same-realm `Event` is trusted: `Window.event` is
  [Replaceable], so a host page's stray `event = {...}` global would otherwise
  shadow the accessor with one object forever and turn the latch into a
  session-long trap that dropped every repeat conversion. Goals fired outside any
  dispatch fall back to one synchronous flush, closed on a microtask, which no
  pending timer can jump either. Hosts without `Window.event` keep the previous
  macrotask window.

  The money now keys the payload too, but asymmetrically. Without it a $50 order
  and a $70 order were the same key and the larger one lost; flattened _into_ the
  key, an inner component declaring `value: 50` nested in a valueless wrapper
  made two keys out of one click — two rows for one order. So within one action
  window, distinct values stay distinct ($50 vs $70 is two records), a valueless
  re-fire is absorbed by any record of the same action, and a valued fire is
  never collapsed by a mere valueless one — the already-sent valueless row can't
  be retracted, and losing the order's value would be the worse error (close-out
  clamps the extra hit's credit; revenue stays correct).

  Two clicks now record two conversions even when nothing but the action
  separates them. The test that found this is no longer quarantined.

- 2f5d3ac: SSR no longer mints an orphan session for every returning visitor. When browser
  storage was namespaced per project, the client began writing the visitor cookie
  under a suffixed name, but three readers kept the old bare `_snt_uid`: the SSR
  helper (`readSessionCookie`, so `loadAdaptiveAssignments` / `loadAdaptiveDecision`
  missed the cookie on every request and generated a fresh session — quota
  inflation, broken sticky assignments, persona continuity lost), graph sync
  (which sent `sessionId: undefined`), and the devtools panel. All three now
  derive the name from the same function the writer uses (`sessionCookieName`,
  newly exported), with the bare name kept as a fallback; a test runs the real
  writer against the reader so they cannot drift apart again.

  The rollout itself no longer resets identities either: a visitor whose id was
  minted under the pre-namespacing bare names is adopted into the suffixed keys
  instead of being issued a new one. The legacy keys are left standing, because
  deleting them would reset any other project on a shared origin that hasn't
  migrated the id yet.

  `readSessionCookie` now takes the project's `apiKey` as an optional second
  argument; without it only the legacy bare cookie is visible.

## 0.21.2

### Patch Changes

- 625aa97: Fixes from the audit of the 20–30 August work. The theme is data that was
  silently wrong rather than visibly broken, so none of it was failing a test.

  **Conversions could be lost.** A goal queued while the durable queue was in
  backoff was held in memory and never persisted — a goal only reached the
  cross-reload bucket after a failed attempt, and `flush()` early-returns during
  backoff, so `pagehide` could not rescue it either. A purchase firing shortly
  after a rate-limited event died on the checkout redirect. `drainBucket` also
  cleared storage before the caller re-sent, while only `maxPerFlush` goals leave
  per tick, so a backlog moved to memory and lost whatever had not gone out.
  Backoff now counts one failed _round_ rather than one per goal in flight, so a
  single bad tick no longer escalates a 2s wait to 32s.

  **The persona portrait was rewritten by the dwell heartbeat.** Dwell is banked
  every 20s, but portrait dimensions are computed per event against thresholds
  calibrated for whole-visit events: the 30s slow-read test became unreachable,
  `attention_span` collapsed ~4x for engaged visitors, and `decision_stage` and
  `reliability_score` scaled with time rather than with visits. Heartbeat chunks
  are now recombined per section before the portrait is computed, so the numbers
  mean what they did before and stay comparable across SDK versions.

  **Custom date ranges were a day early west of UTC.** A date-only bound was cast
  `::timestamptz`, parsed in the session zone and only then read as project wall
  clock, so a US project asking for 1–31 August received 31 July – 30 August. The
  retention floor was an instant compared against a truncated date, so the
  earliest date the picker offered always 403'd, and a malformed bound escaped as
  a 500 rather than the contracted 400.

  **The Promote gate read a skewed posterior.** Per-segment alpha/beta were summed,
  adding the `+1` prior once per segment, so two variants with identical rates but
  different segment spreads could be judged a whole evidence tier apart
  (CONTRACTS §3).

  **The funnel guardrail pauses were destructive and wrong.** The reference rate
  pooled every member component of a funnel, so a landing-stage arm was compared
  against checkout-stage conversion rates and read as a catastrophic regression;
  sessions were also counted once per component seen. Scoped to the arm's own
  component, with the single-arm guard its CVR twin already had.

  **Other fixes.** The narrator worker job is bounded, ordered and advisory-locked
  and no longer stamps a failed generation as a fresh, empty narration; the
  fixed-split A/B readout and the immutable declare-winner ledger row now split
  the error budget across arms (CONTRACTS §5); the composition-block validator
  answers 400 instead of throwing a 500 on prototype-chain keys; MCP renders a
  negative funnel drop-off as a gain with its reason (CONTRACTS §8); plan-gate
  failures speak one vocabulary instead of leaking raw codes like
  `plan_limit_reached` into toasts; and promoting a discovered audience now
  refuses rather than silently retiring persona keys the customer's own site
  still declares in code.

- 625aa97: Closes the remaining open items from the August audit.

  **Crawlers no longer see the hidden-arm DOM.** Composition Blocks pre-render
  every arm hidden in the container with the merchant's own children set to
  `display:none` — hidden duplicate text over real content, on the customer's
  domain. The automation flag has existed on `sessions` since the agentic layer
  shipped but `/v1/decide` never consulted it; it does now, withholding block
  trees entirely from automation sessions so a crawler indexes the merchant's own
  markup. The snippet checks `navigator.webdriver` and the crawler UA tokens as
  well, for the SSR and snapshot paths that never got a session. This is the
  composition spec's §12 hard stop, which was documented as holding and did not.

  **The SQL suite can now fail a release.** `*.integration.test.ts` files skip
  silently without `TEST_PG_URL`, and the CI job that set it (`e2e`) is
  deliberately not a deploy dependency — so the close-out worker, the strict-order
  funnel logic and the window resolver were covered by tests that gated nothing. A
  new `db-test` job runs migrations and the integration suites against a real
  Postgres, `deploy-api` depends on it, and it asserts the suites actually exist so
  an empty filter can never pass as green. `e2e` keeps its browser suite and stays
  out of the deploy path.

  **CONTRACTS.md's own promise is now true.** Its preamble says every constant in
  it is asserted by a test; that was false for §5 and §6, whose serving TTLs and
  winner-exposure floor were module-private. They are exported and pinned in
  `contracts-pins.test.ts`. The persona vocabulary cache also drops from 60s to
  10s, matching the promotion/exclusion caches — while it was stale, another
  instance kept resolving a RETIRED key and writing decision rows under it, and
  close-out trusts those verbatim.

  **Late conversions credit the cells the trial was actually credited under**
  (migration 118). The correction re-derived the persona from the session's
  CURRENT state, but personas drift routinely between the two passes — so a
  session closed as `unknown` could later read as `buyer` and push reward onto
  cells other traffic had created. `updateOnly` prevented minting a cell, not
  crediting an unrelated one (CONTRACTS §2). The slot path never had this bug
  because `slot_decisions.persona` records the decision-time persona; this is the
  variant path's equivalent.

  **A visitor's second purchase records** (migration 119). A unique index keyed on
  `(session, component, goal_type)` discarded it at ingest while still answering
  202, so the SDK purged it from the retry bucket and funnels, revenue and lift
  never saw it. The primary key on the client-generated event id already provides
  exact retry dedupe, and close-out caps reward per session-arm, so this adds
  reporting truth without touching optimizer credit (CONTRACTS §1).

  **A failed session upsert no longer silently costs the whole visit.** The
  session row is a precondition for every conversion — `/v1/goals` answers 400
  without it, and the durable queue treats a 4xx as terminal. `/v1/sessions`
  carries the same per-IP limiter, so under shared egress the session call 429s
  first and every conversion after it was dropped for good. It now retries with
  backoff and says so if it gives up.

  **Discovered-audience assignment.** One `unnest` upsert per project instead of a
  round trip per session under the global discovery lock (it re-assigned the same
  48h window hourly). Assignment confidence is rescaled from its natural [0.5, 1]
  margin onto [0, 1], so the `>= 0.3` personalization gate — calibrated for
  reliability score — actually bites instead of passing everything. Assignments
  are cleared when a shadow set is refit in place or rolled back, because
  migration 116's assumption that `set_id` distinguishes fits does not hold.

  **Also:** presets clamp to the plan's retention and say so via
  `clampedToRetention`, instead of reporting a 90-day window over 30 days of
  surviving data; a slot save that omits `goal` keeps the existing binding rather
  than silently clearing it; the arrangement picker suffixes a colliding slot id
  instead of overwriting the existing component; and the core bundle budget moves
  one step to 13 KiB for the delivery-guarantee fixes, with the reasoning recorded
  in `size-check.ts`.

- 625aa97: Second pass over the August audit — the abuse, availability and
  silently-wrong-surface findings.

  **A deleted composition slot left the merchant's own section hidden.** Blocks
  apply pre-paint from the snapshot, which hides the container's real children,
  but the only code that un-hid them ran inside the apply path — reached only
  while the decide response still carried `blocks` for that slot. Archiving a
  composition slot therefore showed a returning visitor the deleted experiment's
  arrangement with the merchant's hero `display:none` for the whole page view,
  self-healing only on the next visit; a decide timeout wedged it the same way.
  Containers we are no longer serving are now swept back by attribute, including
  when the response carries no slot config at all.

  **A back-navigation invented dwell forever.** `pagehide` disconnected the
  IntersectionObserver regardless of `event.persisted` and nothing re-observed on
  restore, while the heartbeat kept firing — so after a bfcache restore every
  section kept the `intersecting` it held at freeze and banked dwell indefinitely
  for content the visitor had scrolled far past, with the observer that could have
  corrected it already gone. The page now freezes its clocks and resumes on
  `pageshow`.

  **One tenant could spray persona values and serialize the database.** Each
  distinct declared value became its own awaited upsert carrying an `EXISTS` and a
  `COUNT(DISTINCT)` subquery, so one cheap public request mapped to roughly one
  serialized write; the buffer cap was global, so a single noisy project silently
  evicted everyone else's counts. Flushes are now one statement per project, the
  distinct cap is enforced in-process as well as in SQL, and the cap is per
  project.

  **Declared personas are validated at ingest.** `sessions.declared_persona` and
  the unrecognized-value counter (rendered verbatim in Settings) stored whatever
  the browser sent, so a customer wiring `persona={user.email}` filed real
  addresses in both with no erasure path. Values that could not BE a key are now
  refused; a plain typo still counts, so the "add it?" nudge is unaffected.

  **A single authenticated GET could OOM the API.** Nothing clamped a custom
  window's end, and `/agent-activity/summary` had no validation, no retention
  check and closed `BETWEEN` bounds while stepping a per-day `generate_series` —
  `to=9999-12-31` asked Postgres for millions of rows. Window ends are clamped to
  today (so retention already bounds every span), and that endpoint now uses the
  shared resolver like every other reporting surface.

  **`slot-trends` silently ignored the window it was handed.** The proxy was
  taught to forward `range`/`from`/`to` into a handler that had no querystring and
  hardcoded 7/14 days, so picking 90d showed 14 days labelled 90d. Momentum is now
  this window versus the equal window before it, bucketed in the project's
  timezone, with a `window` echo.

  **Prompt injection reachable with a publishable key.** `variant_id` arrives on
  the public ingest path unvalidated and was interpolated raw into the narrator
  prompt, whose output reaches operators via the API and MCP — and the job now
  runs unattended rather than on a click. Identifiers are sanitized and the lists
  capped.

  **Also:** the snippet's goal-dedupe key is namespaced per project (it was the
  one browser key that wasn't, so two projects on one origin suppressed each
  other's goals) and keyed on the full wiring rather than the goal id alone;
  a dropped goal is reported in production, not only under `debug`; `/v1/goals`
  clamps an out-of-range weight instead of 400ing it, matching `/v1/events` (a
  4xx is terminal to the durable queue); the declare-winner pin is written with
  `jsonb_set` so concurrent pins stop clobbering each other; `declare_winner`
  appears in the performance timeline and reads as a sentence in slot history;
  A/B mode is refused on dimension slots, where the readout is structurally always
  empty; an A/B slot without a readout says so instead of borrowing the bandit's
  confidence copy; the persona member cap can no longer be walked past by
  reactivating retired members; MCP labels windows in the project's timezone,
  forwards a `to`-only window, and explains 403 plan gates as plan limits rather
  than access problems; the date picker caps at today in the project's timezone
  and every picker now gets the retention floor from the shared provider rather
  than losing it on the first failed request; and the components stream stops
  reconnecting forever after a rejected window.

- Updated dependencies [625aa97]
  - @sentientui/policy@0.6.2

## 0.21.1

### Patch Changes

- b1acec0: Engagement capture: deliver dwell reliably and stop page-wide wrappers from
  swallowing real sections.

  - Dwell is now banked on a 20-second heartbeat while the page is visible, not
    only on `visibilitychange`/`pagehide`. Dwell that left the page only at
    unload raced the teardown pipeline — in production ~5–8% of sessions ever
    delivered a dwell event, so the urgency and attention-span traits never
    reached the 10% coverage bar. A hard tab close (or a mobile page kill, which
    fires no lifecycle events at all) now loses at most one heartbeat interval.
    The heartbeat restarts the per-section clocks after banking, so accumulation
    continues without a visibility flip. Expect a corresponding increase in
    `dwell` event volume — a few events per minute per visible visitor.
  - Section selection drops layout wrappers: a candidate element containing two
    or more other candidates (typically a div-built page whose page-wide content
    wrapper matches `main > div`) is no longer observed. Previously the outermost
    match won, collapsing every real `<section>` inside it into a single
    `nc-generic` component whose `scroll_depth` was pinned at viewport-height /
    page-height. Single nesting (`header > nav`) keeps the previous attribution:
    the outer element still wins. On div-built pages, dwell attribution moves
    from `nc-generic` to the real per-type sections.

## 0.21.0

### Minor Changes

- 28352a0: Composition Blocks, Phase 1 (Track B2 — spec 2026-08-20 §4/§6).

  Core exports the Composition Block schema: a bounded, typed component tree (`stack`, `grid`, `text`, `heading`, `button`, `link`, `image`, `badge`, `spacer`) whose every prop is an enumerated token — never HTML, never raw CSS. Registry arms may carry a `blocks` tree in `published_config`; the server total-validates each tree at publish (node vocabulary, tokens, https-only URLs, required alt text, depth/node/children caps, ≤ 4 arms with blocks per slot) and serves ALL arms' trees in `slotConfig.blocks` — holdout sessions receive the baseline arm's tree only.

  The snippet renders trees via `createElement` exclusively (no sanitizer because no HTML is ever accepted) using Option B: every arm pre-renders hidden inside the slot container, the served arm is revealed by arm id, and the container's original children are stashed/restored exactly — so structural variants are pre-paint safe and a stale snapshot's reveal is corrected by a toggle, not a re-render. Always-on bundle re-baselined 18 → 20 KiB gzip for the renderer (measured 19,558; documented in size-check.ts).

  Grids render responsive by construction: `auto-fit` columns with an exact cap at the declared count, collapsing on narrow screens — arrangements never author breakpoints.

  No editor yet — arms are authored via the slot-definitions API (the v1 arrangement catalog ships server-side: list + instantiate under mgmt `composition-arrangements`).

  Palette derivation ("derived, not chosen"): the on-site editor overlay samples the site's dominant button look (background, text color, radius) on each open and stores it server-side; registry decisions carrying blocks serve it back, the snapshot caches it, and the renderer brands `emphasis: 'primary'` buttons and corner radius from it — neutral inherit-first defaults when no palette is stored.

### Patch Changes

- 47584a5: Snippet section reordering (Track B1.1) and vocabulary-validated persona preview (B1.2).

  `window.sentient.sections: ['#hero', '#pricing', '#faq']` declares the page sections eligible for adaptive reordering, as CSS selectors in the theme's natural order — mirroring the React `sections` prop. Selectors that resolve on the page ride the existing decide call, and the served `layoutOrder` is applied only under fail-safe bounds: every id must resolve to exactly one element, all elements must share one parent, and the order must be a permutation of what can move — anything else applies nothing, silently. Return visits pre-paint the last served order from the local snapshot (bounded against the current DOM), so a learned layout doesn't flash natural-order first.

  The `?sentient_persona=` preview banner now trusts the server's vocabulary echo: a recognized key shows its display name; an unrecognized value says "isn't in your personas — showing the default experience" instead of claiming a persona `/v1/explain` never simulated.

- Updated dependencies [47584a5]
  - @sentientui/policy@0.6.1

## 0.20.1

### Patch Changes

- 5bae186: Document the declared-persona surface shipped in the previous release: `init({ persona })`, the `persona` prop on `<AdaptiveRoot>`/`<AdaptiveProvider>`, and `window.sentient.persona` (string or function form) now appear in each package README, and the MCP integration guide explains per-project persona vocabularies and declaration instead of the old fixed four-persona list.

## 0.20.0

### Minor Changes

- 2ef60e1: Declared personas: tell the engine the role your app already knows, and the layout/slot optimizer learns per role.

  - **core**: `init({ persona: 'admin' })` — sent on the session upsert and every decide; SSR helpers (`preloadAssignments`/`preloadDecisions`) accept the same option. Declared personas are served at full confidence, overriding the inferred one; values not in the project's persona vocabulary are ignored server-side and surfaced in the dashboard.
  - **react**: `persona` prop on `<AdaptiveProvider>`/`<AdaptiveRoot>`, forwarded through both SSR paths. Stable for the session (decisions are locked per visit); changing it after init warns in dev.
  - **snippet**: `window.sentient.persona` — a vocabulary key string, or a function evaluated once at init (fail-safe: a throwing or non-string getter is treated as undeclared).
  - **policy**: new `resolvePersona` (declared beats inferred), `decisionPersona`, `DEFAULT_PERSONA_VOCABULARY`, `PERSONA_KEY_RE`, `RESERVED_PERSONA_KEYS`; the layout heuristics accept any vocabulary persona (custom personas cold-start on the natural order, like `unknown`).

### Patch Changes

- Updated dependencies [2ef60e1]
  - @sentientui/policy@0.6.0

## 0.19.1

### Patch Changes

- c8dd0d4: Fix pageview capture lifecycle and goal dedupe edge cases.

  - Page-journey tracking now tears down with the client: `dispose()`/`destroy()`
    remove the `popstate` listener and unhook the history patch (when still on
    top). Previously every re-`init()` — consent changes, React StrictMode, HMR —
    stacked another history wrapper, and disposed clients kept emitting, so a long
    SPA session after a consent re-grant delivered duplicate pageviews.
  - The landing pageview is recorded once per (project, path) per page lifetime,
    marked only after the event reached a live queue — so consent re-mounts no
    longer double-count the landing page, and StrictMode still delivers exactly one.
  - A mixed event batch that an API older than the `pageview` event type rejects
    with a 4xx is now re-sent once without the pageviews, so co-batched exposures
    and goals survive against not-yet-upgraded self-hosted APIs. This corrects the
    previous release note, which claimed older APIs accepted the events — they
    rejected the whole batch.
  - The goal dedupe key now includes `stepIndex` and `weight`, so distinct funnel
    steps of one goal fired in the same handler are both kept; only identical
    calls collapse to one record.
  - The goal dedupe window is cleared via `MessageChannel` instead of
    `setTimeout(0)`: mocked timers in integrator test suites froze the latch open
    (swallowing every later same-name conversion), and background-tab timer
    throttling stretched "one action" across genuinely separate ones.

  Known limitation, unchanged: hash-based routers never change `location.pathname`
  (the only part of the URL the SDK reads, by design), so such sites record a
  single page.

## 0.19.0

### Minor Changes

- 1ce4b77: Capture the page a visit is on. Every event now carries `path`, and a `pageview`
  event fires on load and on each SPA route change (pushState/replaceState/popstate,
  deduplicated by pathname so one navigation is one pageview).

  Only `location.pathname` is sent — never `href` or the query string, so emails,
  reset tokens and order ids that sites routinely put in URLs never leave the
  browser. The server strips them again on ingest.

  Nothing is required of integrators: the capture starts with `init()`. Requires
  migration 108 on the API side; older SDKs keep working and their events simply
  store no path.

### Patch Changes

- 1ce4b77: Record one conversion per user action, not one per listening component.

  Every `<Adaptive>`/hook path fires `componentGoal()` **and** `goal()`, so two
  nested components declaring the same goal label wrote two `goal_events` rows for
  a single click. A weight-1.0 goal was hidden by the server's `min(1, …)` cap,
  but a weighted composite step (say 0.3) was credited 0.6, and the Goals page's
  Hits column — a `COUNT(*)` — double-counted regardless.

  `goal()` now collapses repeat calls for the same goal name within one task, the
  window in which a single event dispatch runs. Two real clicks are always
  separate tasks, so genuine repeat conversions are unaffected, and calls carrying
  distinct `externalId`s are never collapsed — those are distinct orders by
  definition. A collapsed call is reported under `debug: true`.

## 0.18.1

### Patch Changes

- 6cfe1c2: `client.goal()` now has a delivery guarantee.

  It was the only call in the SDK that bypassed the durable event queue: a bare
  `fetch(...).catch(() => {})` cannot observe a resolved error response, so a 429
  (the API's per-IP limit is 100/min, which shared egress — corporate NAT, mobile
  carriers, storefront proxies — hits routinely), a 5xx, or a 400
  `session not found` all resolved and were discarded unread. The conversion was
  gone with no retry and nothing surfaced to the developer.

  Conversions now go through the same machinery as every other event: immediate
  send, retry with backoff on 429/5xx, a localStorage bucket that survives reload,
  and dedupe by id. This was always safe — `goalId` is a client-generated UUID the
  server dedupes on — it simply wasn't attempted. A backlog drains at a paced rate
  so recovering from a 429 cannot re-trigger it, and a goal dropped for a
  non-retryable reason is now reported through `config.debug` with the likely
  cause instead of vanishing silently.

  `EventType` also gains `'funnel_declared'`, which the server has always
  accepted. No API removals; existing code keeps working unchanged.

- Updated dependencies [5a2515f]
  - @sentientui/policy@0.5.0

## 0.18.0

### Minor Changes

- 6dade33: `GoalDefinition` accepts the new `scroll_depth` event with an optional `threshold` (fraction of the page, 0–1, that counts as read). Types-only — the runtime bundle is unchanged.

### Patch Changes

- Updated dependencies [6dade33]
  - @sentientui/policy@0.4.0

## 0.17.0

### Minor Changes

- 32996be: `goal()` and `componentGoal()` accept revenue values: `client.goal('purchase', { value: 129.99, currency: 'EUR', externalId: order.id })`. The value feeds revenue reporting and (once enough valued conversions exist) value-aware optimization. The positional `goal(name, metadata, weight, stepIndex)` form still works and is deprecated.

## 0.16.10

### Patch Changes

- 8ed4d0b: Consent can now start tracking without a page reload.

  `grantConsent()` only ever worked for clients created with
  `preConsentBehavior: 'statistical_winner'`. In `'control'` mode — the documented
  default, and the only pre-consent mode that makes no network request — the
  client was registered with no upgrade hook, so `grantConsent()` returned
  silently and the site had to reload to start tracking. Every gated client now
  gets an upgradeable proxy; control mode still sends nothing until consent.

  `<AdaptiveRoot consent={false}>` also ran its SSR `/v1/decide` and minted a
  session row, despite the documented contract of "no SDK is initialised, no
  cookies are written, no events are sent". It now skips the server call and the
  session entirely, matching the existing DNT/GPC behaviour — so it is safe to
  render unconditionally and gate with the prop instead of hiding it behind a
  conditional render.

  Together these remove the `router.refresh()` round trip from consent-gated
  Next.js apps, which silently lost every visitor who accepted and left before the
  re-render landed.

  New `consentFrom` prop on `<AdaptiveProvider>` / `<AdaptiveRoot>`: point it at
  the cookie (or a `check()` predicate, for CMPs with a JS API) and the window
  event your banner fires, and the SDK gates and un-gates itself. It reads the
  source on mount, re-reads it on every event — the payload is never trusted, so
  any CMP's event works and a "declined" decision stays gated — and initialises
  the moment it grants. This replaces hand-wiring `grantConsent()` in a component
  of your own, and removes the ordering hazard that came with it (a child of the
  provider would have called it before the provider had initialised).

  `<AdaptiveRoot>` resolves a cookie-based `consentFrom` from the request itself,
  so an already-consented visitor still gets SSR variant assignment with zero
  layout shift without the app calling `cookies()` and naming the cookie twice.

  `grantConsent` is also re-exported from `@sentientui/react` for apps that drive
  consent manually, so they no longer need `@sentientui/core` as a direct
  dependency.

## 0.16.9

### Patch Changes

- de26748: Add agent-fetch intent classification: `agentIntent(botName)` labels a matched agent user-agent as `user` (an assistant answering a real person, live), `search` (answer-engine index), `training` (model crawl), or `other`, and `classifiedAgents()` returns the full `agentUaList` grouped by intent. The `AGENT_INTENTS` map is maintained beside `agentUaList`.

## 0.16.8

### Patch Changes

- 8663750: Browser storage is now namespaced per project. The visitor id (`_snt_uid`), assignment cache (`_snt_asgn_*`), and graph-node cache (`_snt_graph_nodes`) are suffixed with the `pk_` key prefix, matching the retry queue's existing convention. This fixes cross-project collisions when two SentientUI keys run on the same exact origin — most importantly, two projects previously shared one `_snt_uid`, and because sessions are keyed globally server-side, one project's traffic could land on another project's session row.

  Note: because the visitor-id key name changes, existing returning visitors are assigned a fresh id once on upgrade (their prior anonymous profile is orphaned). Single-project sites are otherwise unaffected; local mode (no key) keeps the legacy key names.

- 8663750: Graph sync is now data-minimizing by default. Page URLs are reduced to `origin + pathname` (`sanitizePageUrl`), so query strings and fragments — which can carry tokens, emails, or other sensitive params — never leave the browser. Captured heading / DOM text is now opt-in via `captureDomText` (off by default); component structure (ids, semantic types, prominence) still syncs when `graph` is enabled.

## 0.16.7

### Patch Changes

- 8ecd00f: Point `repository` metadata at the public source mirror (`github.com/SentientUI/sdk`)
  so the "Repository" link on npm resolves, and add a `bugs` URL for issue reporting.
  No runtime changes.
- Updated dependencies [8ecd00f]
  - @sentientui/policy@0.3.3

## 0.16.6

### Patch Changes

- 0da8854: Reliability and correctness fixes in the client core:

  - Session IDs now always come from a shared RFC 4122 v4 generator. The previous
    insecure-context fallback (`http://` non-localhost pages, where `crypto` is
    absent) emitted a malformed `8-8-8-8` id that the API's Postgres `uuid`
    columns reject with `invalid input syntax for type uuid`. Event ids reuse the
    same hardened helper. The generator now prefers `crypto.getRandomValues` (a
    CSPRNG available in insecure contexts) over `Math.random`, falling back to
    `Math.random` only when no Web Crypto exists at all — so it never throws.
  - The `@sentientui/core/graph` entry no longer leaks a `MutationObserver` and a
    pending sync timer when re-initialized for the same key (HMR, consent toggle,
    provider remount). Each mount's graph resources are now torn down when a new
    mount supersedes them, mirroring the lean client's existing re-init guard.
  - The event queue purges a batch from the localStorage retry backstop once it is
    acknowledged, so a transient 5xx that was persisted is not replayed on the
    next page load after the in-session retry already delivered it.
  - The persisted retry bucket is now de-duped by `event.id` (last write wins)
    before the size cap. A batch that 5xx'd repeatedly in-session used to append a
    fresh copy of every id on each retry, and the `slice(-maxRetrySize)` cap then
    evicted other distinct failed events to make room for the duplicates.
  - An empty `_snt_uid=` cookie (or empty localStorage/sessionStorage entry) is now
    treated as absent instead of being adopted as the session id. Previously the
    falsy `''` was persisted for a year and made `getSessionId()` return empty, so
    every track/goal/graph-upsert silently bailed and the visitor was permanently
    muted with no way to regenerate.
  - The DOM scanner synthesizes a stable, unique `componentId` (tag + DOM-path
    hash) for components that declare no `data-sentient-id`/`id`. The old
    `tagName.toLowerCase()` fallback gave every id-less `<section>` the same id, so
    a second such node silently overwrote the first in the componentId-keyed graph
    map (node loss).
  - Incremental graph detection now resolves parents against the full set of nodes
    registered so far, not just the nodes in the current mutation. A child inserted
    under an already-scanned parent now produces its parent→child structural edge
    instead of none.
  - Structural-edge detection caps the sibling fan-out per group and the total
    edges per pass, so a page with hundreds of co-located components no longer
    emits tens of thousands of low-signal sibling edges (kept well under the
    server's per-sync edge limit).
  - Graph sync beacons now carry the configured `sessionId`/`projectId` in the
    `/graph/sync` payload, restoring the visitor attribution the config surface was
    always meant to transmit (the server tolerates the extra fields).
  - The `@sentientui/core/graph` entry no longer double-loads persisted page nodes:
    the graph client constructor is now the single load path, dropping the
    redundant re-read + `restore()` that cleared and reloaded identical data.
  - Minor: `probeCookieWritable` no longer hardcodes the default cookie name; the
    scanner drops a redundant no-op normalization in the prominence score.

- Updated dependencies [0da8854]
  - @sentientui/policy@0.3.2

## 0.16.5

### Patch Changes

- cb11a47: Reliability and correctness fixes in the client core:

  - Failed event batches (including `goal_achieved` conversions) now retry in-session instead of only on the next page load, so a bounced visitor no longer loses queued events.
  - `section-map` registration no longer double-prefixes `/v1`; the endpoint URL is normalized whether the configured base ends in `/v1` or not.
  - Server-provided `assignmentTtlMs` is now honored by the assignment cache instead of a fixed 30-minute TTL.
  - Fixed an in-memory assignment cache key collision when segments contain `:`.
  - Repeated `init()` for the same key now disposes the prior client (timer + listeners) instead of leaking them; `destroy()`/`dispose()` clear the client registry entry.
  - `decide()` no longer downgrades a known persona to `unknown` (and no longer persists that regression to the snapshot).
  - Added the optional `sectionMap` field to `DecideOutcome` and forwarded it through `decide()`.

## 0.16.4

### Patch Changes

- f27780c: Fix product-audit findings across the client runtimes:

  - **react**: `<Adaptive>`/`useAdaptive` no longer emit a phantom `variant_assigned`
    exposure for the interim baseline on the client-only (no-SSR) path — exposure is
    now gated on a settled assignment, so the baseline arm's conversion rate is no
    longer diluted. Slot exposures (`useAdaptiveTokens`/`AdaptiveGroup`) are gated on
    a resolved (non-baseline) source and warn once in dev when a keyed client settles
    on baseline without SSR. Dev `?sentient_variant=`/`?sentient_persona=` overrides
    are resolved after mount to avoid an SSR hydration mismatch. The degraded
    client-side weights fallback now shrinks toward a prior instead of picking a
    lucky single-pull variant.
  - **snippet**: `url_reached` goals match on exact path / segment boundary instead of
    substring, so a homepage `/` goal no longer fires on every page; section
    engagement capture restarts on SPA navigation (and its listeners are cleaned up on
    consent revoke); section-level `tab_loss` fires once per page instead of once per
    section; `reapply()` restamps reversible attributes only until `/v1/decide`
    resolves (no stale-copy flash); a decide with no slotConfig clears the cached one;
    the text-test editor rejects an empty alternative.
  - **core**: section engagement capture attaches the document-level `tab_loss`
    detector once (first section) rather than per section.

## 0.16.3

### Patch Changes

- 47a0306: Add an optional `tabLoss` flag to `attachMicroSignalDetectors`. The `tab_loss`
  signal is document-level (not node-scoped), so a caller that attaches detectors
  to many nodes at once — e.g. the snippet's per-option slot signals — would emit
  one `tab_loss` per node on a single tab-hide. The flag lets such callers enable
  it on just one node. Defaults to enabled, so existing callers are unaffected.

## 0.16.2

### Patch Changes

- 150cd26: Flush the event queue on `pagehide` instead of `beforeunload` so pages stay eligible for the back/forward cache, plus micro-signals and graph-index refinements.
- Updated dependencies [150cd26]
  - @sentientui/policy@0.3.1

## 0.16.1

### Patch Changes

- b4fcf4a: Keyless/local mode is zero-network again: the DOM-graph scanner and engagement-capture section registration now refuse to start without an API key, so no /v1/graph/sync or /v1/section-map beacons fire for keyless installs.

## 0.16.0

### Minor Changes

- 6a09ead: Content-based section classification (pricing/social-proof/trust/comparison detected from body text, not just ids/headings), explicit `data-sentient-type` precedence in engagement capture, and a `typeOf` hook for server-served section maps.

### Patch Changes

- Updated dependencies [6a09ead]
  - @sentientui/policy@0.3.0

## 0.15.0

### Minor Changes

- 2c6420b: Personas now work out of the box. **Behavior change:** DOM graph scanning (`enableGraph`) and behavioral engagement capture (per-section dwell/scroll + semantic section detection) are now ON by default in the React provider, and `sectionCapture` is ON by default in the no-code snippet. Opt out with `enableGraph={false}` / `engagement={false}` (React) or `sectionCapture: false` (snippet). Do-Not-Track, Global Privacy Control, and consent gates are unchanged and always win. Also: semantic types are auto-detected for untagged sections (explicit `data-sentient-type` still takes precedence) and invalid explicit types are normalized instead of breaking graph sync.

## 0.14.0

### Minor Changes

- 5d2e0ad: Richer no-code slot ops: reorder + expanded styles.

  - **core**: `SlotOps` gains `moveBefore`/`moveAfter` (reposition an element relative to a uniquely-resolving sibling anchor); the decide input accepts an optional `v` (embedded snippet version) that is forwarded on the wire so the dashboard can flag out-of-date embeds.
  - **snippet**: the apply engine adds a fail-safe reorder op (unresolved/ambiguous/cross-parent anchors apply nothing and report a locator miss; post-decide only, never pre-paint) and 10 new whitelisted style properties (`width`, `height`, `maxWidth`, `border`, `boxShadow`, `opacity`, `lineHeight`, `letterSpacing`, `textTransform`, `gap`). The on-site editor gains Move up / Move down authoring and audit-target pre-highlighting, and the snippet now reports its version on decide.

## 0.13.1

### Patch Changes

- 55c99bd: Fix traffic-source detection misclassifying look-alike hosts as social. The social-network match had no right-hand boundary, so referrers like `x.company.com`, `t.company.io`, and `linkedinsights.com` were classified as `social` — placing those sessions on the wrong `device:source` optimizer segment. Matching is now anchored to the registrable domain (exact host or a subdomain of it).

## 0.13.0

### Minor Changes

- e69dfe1: No-code adaptive registry: serve dashboard-defined slots and goals from the snippet, with bounded ops, compound locators, and an on-site editor.

  - **Registry mode** (`slotsFrom: 'registry'`): a bare `window.sentient = { apiKey }` install adapts the project's published dashboard slots automatically. `decide()` returns `slotConfig` (target/kind/content/ops) and editor-defined `goals`; the snapshot carries them for return-visit pre-paint.
  - **Bounded ops**: registry arms can apply a whitelisted style set + text/href/image via a generated `!important` stylesheet — never innerHTML, never arbitrary CSS/JS.
  - **Compound locators**: `id → data-attr → selector` resolution with fingerprint verification; zero/ambiguous/fingerprint-fail means no change (never guesses). Unresolved slots report a `locator_miss` so the server can auto-suspend broken slots.
  - **Editor-defined goals**: click / form-submit / URL-reached goals delivered with the decision; the snippet installs delegated listeners that fire the existing `goal()` / `componentGoal()` paths.
  - **On-site visual editor**: `?sentient_editor=<token>` loads a separate overlay bundle (zero bytes on the normal path) to pick elements and save drafts; the token is stripped from the URL immediately.
  - **Section capture** (`sectionCapture: true`): opt-in, records per-section dwell/scroll to power the persona × section matrix for no-code sites. Reuses the existing event pipeline and is hard-gated on the DNT/GPC + consent state — it never runs for an opted-out visitor.
  - New snippet config passthrough: `consent`, `preConsentBehavior`, `debug`, `registry`, `editorSrc`, `apiBase`, `sectionCapture`.

## 0.12.1

### Patch Changes

- 6794bb7: Honor Do Not Track and Global Privacy Control everywhere, and stop minting visitor identity for opted-out visitors.

  - **GPC**: `navigator.globalPrivacyControl` (and `Sec-GPC: 1` on the server) is now treated as a tracking opt-out alongside DNT. GPC is the legally-enforceable CCPA/CPRA signal and was previously ignored.
  - **Keyless / local mode** no longer writes the 365-day `_snt_uid` cookie for a DNT/GPC visitor — the opt-out is now evaluated before the local-mode branch, which used to call `initSession()` unconditionally.
  - **Graph mode** (`@sentientui/core/graph`) no longer mounts the DOM scanner or POSTs page structure / reads `_snt_uid` for an opted-out visitor, even under `preConsentBehavior: 'statistical_winner'`.
  - **SSR**: `preloadAssignments` / `preloadDecisions` gain a `doNotTrack` option that skips the session upsert and the assign/decide call, so no session row is minted server-side for an opted-out visitor. `@sentientui/react`'s `<AdaptiveRoot>` sets it automatically from the `DNT` / `Sec-GPC` request headers, and `loadAdaptiveAssignments` / `loadAdaptiveDecision` forward it.

## 0.12.0

### Minor Changes

- 73f7c59: Teardown semantics are now split in two. New `client.dispose()` stops timers/listeners and flushes pending events but keeps the visitor identity, decision snapshot, and retry bucket — use it for routine cleanup (framework providers call it on unmount). `client.destroy()` remains the consent-revocation/forget-me teardown and now removes the decision snapshot (`_snt_snap:<apiKey>`) and the persisted retry bucket in addition to the identity cookie/storage keys — previously the persona/slot snapshot survived and the pre-paint script kept personalizing the next visit after consent revocation.

## 0.11.2

### Patch Changes

- c37feb3: Documentation corrections, no behavior changes: `context` is a local debug label (never sent to the server); graph mode activates via `init({ graph: true })` from `@sentientui/core/graph` (a bare import does nothing); `client.destroy()` deletes the 365-day visitor identity and is for consent revocation, not page unload; `goal()` step weights credit at visit close-out, not instantly; dev overrides are implemented by `@sentientui/react`, not this package; the init-option table now documents `preConsentBehavior`, `respectDoNotTrack`, `ssrSessionId`, and `country`.

## 0.11.1

### Patch Changes

- Docs: correct the install command from `npx sentientui init` to `npx @sentientui/cli init`. The published package is scoped, so the bare `sentientui` name 404s on npm. Updates the CLI usage/help text and package description, the MCP integration guide, and the `llms.txt` agent-facing docs.

## 0.11.0

### Minor Changes

- 8fb5c32: The adaptive ladder. Four public rungs — Observe, Style, Swap, Reorder — with keyless local
  mode and a 60-second `npx sentientui init` onboarding.

  - `@sentientui/react` 0.14.0: `useAdaptiveTokens` (learned style tokens), `useAdaptive`
    (headless swap, supersedes `useAssignment`), `<AdaptiveGroup>` (bounded reorder), persona
    attributes on `<html>` (`data-sentient-persona` / `data-sentient-confidence`),
    `AdaptiveRoot slots`, testing scenarios for slots/persona.
  - `@sentientui/core` 0.11.0: client-side `decide()` with slots, `getSlotResult`/`getPersona`,
    decision snapshot + `renderPrePaintScript`, keyless local mode via `@sentientui/core/local`
    (development export condition only).
  - `@sentientui/policy` 0.2.0 (new): shared pure decision policy — personas, layout heuristics,
    hashing, Thompson sampling, arm encoding, shrinkage — used by the API and local mode.
  - `@sentientui/cli` 0.2.0 (new): `npx sentientui init` scaffolding.
  - `@sentientui/snippet` 0.2.0 (new): Style-rung IIFE snippet for non-React sites (<= 15 KB gzip).

### Patch Changes

- Updated dependencies [8fb5c32]
  - @sentientui/policy@0.2.0

## 0.9.1

### Patch Changes

- Lower the default SSR preload `timeoutMs` from 1500 ms to 1000 ms in `preloadDecisions`/`preloadAssignments` and `<AdaptiveRoot>`.

  A decide served from the API's in-process cache typically returns in well under 150 ms; the full 1 s budget is only reached on a cold start or an API geographically distant from your SSR host, after which default variants render with no layout shift. Override `timeoutMs` if your API is co-located and warm (the SentientUI site itself uses 400 ms).

## 0.9.0

### Minor Changes

- f3ea544: Honor the browser's Do Not Track (DNT) signal. New `respectDoNotTrack` config option (default `true`) on `init()` and the React `AdaptiveProvider`. When a visitor has DNT enabled, the SDK sets no cookies and sends no tracking data — overriding `consent: true` and preventing `grantConsent()` from re-enabling tracking. If `preConsentBehavior: 'statistical_winner'` is set, the read-only winner is still served (nothing stored). Set `respectDoNotTrack: false` to make your own consent gate authoritative. Also exports `isDoNotTrackEnabled()` from core.

  This aligns the SDK's behavior with the Do Not Track claim already in the cookie disclosure. Note DNT is a supplementary opt-out, not a replacement for the `consent` gate — opt-in consent is still required for EU/California visitors.

## 0.8.2 — 2026-07-01

### Added

- **`SentientClient.componentGoal(componentId, goalType, opts?)`** — records a conversion attributed to the variant currently served for `componentId`, so it feeds the per-variant CVR funnel. Resolves the served variant from the local assignment cache — callers pass no `variantId` or `projectId`. Emits a `goal_achieved` event (the same signal `<Adaptive goal>` fires); no-ops with a `debug` warning when the component has not been assigned yet. `SSR_CLIENT` and the pre-consent proxy are no-ops. Prefer over hand-rolled `track({ eventType: 'goal_achieved', … })` for variant experiments.
- **`ComponentGoalOptions` type** exported from `@sentientui/core`.

### Fixed

- **`track()` now waits for session to be established before entering the flush queue** — previously `track()` pushed events synchronously while `goal()` and `assign()` awaited `sessionReady`. On slow networks, the queue could flush with a batch that referenced a `sessionId` before the session POST completed. Events are now queued via `sessionReady.then(...)`, preserving the correct timestamp and timeInSession while preventing FK-violation drops on the first flush.

---

## 0.8.1 — 2026-06-30

### Added

- **`SentientClient.fetchWeights()`** — fetches current bandit weights from `GET /v1/weights`. Returns `ComponentWeightEntry[]` with `variantId`, `pulls`, and `avgReward` per variant. `SSR_CLIENT` and the pre-consent proxy return `[]`. Used internally by `AdaptiveProvider` for live-weight polling; available to advanced callers who want to read weights directly.
- **`WeightEntry` / `ComponentWeightEntry` types** exported from `@sentientui/core`.

### Fixed

- **SSR error visibility** — `preloadAssignments` and `preloadDecisions` previously swallowed all API errors silently, making misconfigured keys, origin mismatches, and network failures invisible. Failures now log to `console.error` with the HTTP status and response body, so issues appear in the Next.js server console (or hosting platform logs) immediately.

### Fixed

- **`ssrSessionId` adoption tests** — added three cases to `session.test.ts` covering: adopts the SSR ID on first visit, ignores it when a cookie already exists, ignores it when localStorage has a value.

---

## 0.8.0 — 2026-06-14

### Breaking Changes

- **`loadAdaptiveAssignments` return type changed** — the function now returns `Promise<{ assignments: ServerAssignments; sessionId: string }>` instead of `Promise<ServerAssignments>`. Update callers:

  ```diff
  - const assignments = await loadAdaptiveAssignments(components, options);
  + const { assignments, sessionId } = await loadAdaptiveAssignments(components, options);
  ```

  Pass `sessionId` as `ssrSessionId` on `<AdaptiveProvider>` (see below). `AdaptiveRoot` users are unaffected — it handles this automatically.

- **`loadAdaptiveDecision` return type changed** — similarly now includes `sessionId`. The `AdaptiveRoot` component handles this internally; callers using `loadAdaptiveDecision` directly should destructure the same way.

### Added

- **`ssrSessionId` on `SentientConfig` and `AdaptiveProviderProps`** — when set, the client adopts this ID on first visit instead of generating a new one, fixing a long-standing bug where the server and client produced two independent sessions on first page load. This caused events, goals, and bandit attribution to be split across orphaned sessions.

  ```tsx
  const { assignments, sessionId } = await loadAdaptiveAssignments(components, options);
  <AdaptiveProvider ssrSessionId={sessionId} initialAssignments={assignments} ...>
  ```

  `AdaptiveRoot` wires this automatically when you use the Next.js Server Component.

- **`SessionConfig.ssrSessionId`** — `initSession()` now accepts this option and uses it as the fallback session ID when no cookie or localStorage entry is found, rather than generating a fresh random ID.

### Fixed

- **`ClickGoal.selector` now respected** — `<Adaptive goal={{ type: 'click', selector: '.pricing-cta' }}>` previously fired on any clickable element inside the slot. The selector is now checked via `element.closest(selector)` before the goal fires, for `click` goals at every nesting level (single, composite, weighted_composite).

- **Graph incremental sync** — `domScanner.observe()` callbacks now trigger a debounced `syncOnce()` (500 ms) so dynamically added content is reflected in `/v1/graph/sync` instead of only being stored locally in `localStorage`.

- **`AdaptiveText` + `initialAssignments` — text no longer stuck on default** — when `initialAssignments` seeded the cache for a component, `assign()` returned the cached entry immediately without ever fetching the managed text content, leaving the component permanently showing `default`. Fixed by allowing the API call through when the cache entry has no `content` and `variantIds` is absent.

- **Dev override console log throttled** — `console.info('[sentient] override active…')` no longer fires on every render. A ref guard ensures it logs once per override value.

- **`__lastIOCallback` no longer leaked in production** — the test hook `window['__lastIOCallback']` set by `attachMicroSignalDetectors` is now guarded behind `NODE_ENV !== 'production'`.

## 0.7.1 — 2026-06-14

### Added

- **`MicroSignalType`** — exported type alias for micro-signal names (`rage_click`, `text_copy`, `scroll_hesitation`, `tab_loss`). Pairs with `@sentientui/react`'s `microSignalGoals` prop.

## 0.7.0

### Minor Changes

- 5fb52a7: Default API endpoint moved to `https://api.sentient-ui.com` (previously `https://sentient-api.fly.dev`). The new domain terminates TLS on an anycast edge close to your users and decouples the SDK from the hosting provider. Non-breaking: the old hostname remains valid, and explicit `ingestUrl` / `baseUrl` overrides are unaffected.

## 0.6.0

### Minor Changes

- SDK performance pass (Phase 2 of the performance audit).

  `@sentientui/core`:

  - **Breaking**: SSR preload helpers (`preloadAssignments`, `preloadDecisions`, `readSessionCookie` and their types) moved from the root entry to a new `@sentientui/core/server` entry, removing ~200 lines of Node-only fetch code from the browser bundle. Update imports from `'@sentientui/core'` to `'@sentientui/core/server'`.
  - Concurrent `assign()` calls for the same component are now coalesced into a single `/v1/assign` request.

  `@sentientui/react`:

  - Fixed a systematic assignment-cache miss: `AdaptiveProvider` now derives the default `sessionSegment` (`device:source`) exactly like core `init()` instead of hard-coding `desktop:direct`, so cache reads and writes agree when `sessionSegment` is not passed.
  - `previewHtml` (up to 30 KB) is now sent at most once per (component, variant) per browser session instead of on every mount — the server keeps the first-seen preview anyway.
  - The provider context value is memoized, preventing parent re-renders from cascading through every `useAssignment` consumer.
  - Distributed bundles are now minified (~50% smaller).

### Added

- **`attachMicroSignalDetectors(emit, node, variantAssignedAt?)`** — passive behavioral detector. Attaches rage-click, text-copy, scroll-hesitation, and tab-loss listeners to a DOM node. Each signal fires at most once per call. Returns a cleanup function. Used internally by `<Adaptive>` — export is available for advanced use cases.
- **`MicroSignalEmitter` type** — `(signalType, extra?) => void` callback signature for the above.
- **`weight` and `stepIndex` on `client.goal()`** — `goal(name, metadata?, weight?, stepIndex?)`. Both default to `1.0` / `0` respectively and are forwarded to `POST /v1/goals`.

## 0.5.0

### Added

- **`agentDataByVariant` parameter on `client.assign()`** — fourth optional argument (`Record<string, unknown>`). When provided, takes precedence over `agentData`: only the entry matching the assigned variant ID is stored, so agents see exclusively what was served to the visitor rather than a shared blob across all variants.

## 0.4.0

### Added

- **`agentData` parameter on `client.assign()`** — optional third argument (`unknown`). When provided, the value is included in the `/v1/assign` request body so the server can store it per variant for the Agentic Content API.
- **`grantConsent()`** — upgrades a pre-consent proxy client (created with `consent: false, preConsentBehavior: 'statistical_winner'`) to a fully-tracking client in place. Call from your CMP's consent callback; for React apps prefer updating the `consent` prop on `<AdaptiveProvider>`.
- **`preConsentBehavior` on `SentientConfig`** — `'statistical_winner'` fetches the best-performing variant via `GET /v1/winner` with no session or tracking data stored; `'control'` (default) shows `variantIds[0]` with no API call. Only applies when `consent: false`.

## 0.3.1

### Patch Changes

- Add SSR timeout with fallback to prevent cold API from blocking page render

  `preloadAssignments` and `preloadDecisions` now abort after 1500 ms by default and return
  default variants rather than hanging the server indefinitely. The timeout is configurable
  via a new `timeoutMs` option on `ServerAssignConfig`, `loadAdaptiveAssignments`,
  `loadAdaptiveDecision`, and `<AdaptiveRoot>`.

## 0.3.0 — 2026-05-29

### Added

- **`preloadDecisions()`** — single-roundtrip SSR helper that calls `POST /v1/decide` to resolve both layout order and variant assignments in one request. Drop-in replacement for `preloadAssignments()` when using `<AdaptiveRoot sections={…}>`.
- **`client.goal(name, metadata?)`** — fire a named conversion goal directly from the client. Posts to `/goals` after the session is established; safe to call server-side (no-op on SSR_CLIENT).
- **`client.identify(userId)`** — links the current anonymous session to an authenticated user ID. Sends an identify event so server-side portraits and bandit weights carry over across sign-in.
- **`userId` on `SentientConfig`** — pass a known user ID at init time; threaded into the session-start payload so server-side association happens immediately without a subsequent `identify()` call.
- **`content` field on `AssignResult`** — API-delivered variant content string, populated when the server has a content payload for the variant (used by `<AdaptiveText>`).

## 0.2.1

### Patch Changes

- 7d31c76: Fix ingestUrl removal fallout: guard empty ingestUrl in core init(), resolve undefined ingestUrl in graph entry, remove stale ingestUrl/apiBaseUrl props from AdaptiveProvider and AdaptiveRoot call sites.

## 0.1.0 — 2026-05-18

### Added

- `init(config)` — initialises the client with session management, event batching, and assignment cache. Returns a no-op `SSR_CLIENT` on the server or when `consent: false`.
- **Event queue** — batches events in memory, flushes every 5 s or immediately on `visibilitychange` to `hidden` via `fetch` with `keepalive: true`.
- **Assignment cache** — per `(componentId, segment)` TTL cache seeded from `initialAssignments` so the first client render never makes a network call.
- **Session management** — `_snt_uid` first-party cookie for session continuity; ephemeral (private-browsing) sessions detected and flagged; `session.destroy()` clears cookie, localStorage, and sessionStorage.
- **Segment derivation** — `device:source` from User-Agent + referrer (e.g. `mobile:search`, `desktop:direct`).
- **`preloadAssignments`** — server-side helper for `getServerSideProps` / middleware; calls `POST /v1/assign` for multiple components in parallel.
- **`readSessionCookie`** — reads the `_snt_uid` cookie in Node.js/Edge contexts.
- **`init()` guards** — rejects missing/malformed `apiKey` (not `pk_` prefix) and empty `ingestUrl`; returns no-op client with `console.warn`.
- **`@sentientui/core/graph` entry point** — separate bundle for DOM scanner and graph sync; tree-shaken from the lean bundle. Import `init` from `@sentientui/core/graph` and pass `graph: true` to enable.

### Bundle sizes (gzip)

| Entry                    | Size   | Limit   |
| ------------------------ | ------ | ------- |
| `@sentientui/core`       | 3.9 KB | 8.0 KB  |
| `@sentientui/core/graph` | 6.2 KB | 16.0 KB |
