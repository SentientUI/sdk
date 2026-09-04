# @sentientui/snippet

## 0.18.0

### Minor Changes

- c69cdaf: September audit fixes. Consent: `grantConsent()` on a `consent:false` boot now installs the editor-defined goal listeners (consent-gated sites previously recorded zero goals per visit); a revoke during the in-flight decide no longer re-persists the snapshot; `revokeConsent()` clears the fired-goals sessionStorage; `getState().consent` reflects the live flags. Robustness: post-decide apply defers to `DOMContentLoaded` for async/GTM installs (no more false locator misses suspending healthy slots); a decide resolving after the 5s timeout is applied late instead of losing the whole view; invalid selectors are guarded per-slot and `getState()` never throws into host code; a safe no-op global API is installed even on config errors so `SentientSnippet.goal()` never throws; `matchAll` replaced with an ES2017-safe loop (iOS 12-era engines); unknown block gap tokens fall back to `md`; the editor loader removes its `no-referrer` meta on load failure; persona preview survives hydration via SPA hooks; the editor funnel-attach form uses the selected funnel's steps and surfaces failures instead of posting a null step behind a success toast.

## 0.17.2

### Patch Changes

- 2f5d3ac: Editor and preview modes no longer strand the page's `SentientSnippet` API.
  Those paths returned before the runtime global was exposed, leaving the
  build-time module exports in its place — so merchant code calling
  `SentientSnippet.goal(...)` threw, and conversions queued on a pre-boot stub
  were never drained. The modes still suppress all tracking: the API they expose
  now is a no-op surface (no client behind it), and the pre-boot queue drains
  harmlessly into it instead of replaying into a later real visit.
- 2f5d3ac: `revokeConsent()` followed by `grantConsent()` no longer kills tracking until a
  reload. Revoke destroys the core client — which also deletes its registry
  entry — but the snippet kept pointing at the dead client, so a later grant
  warned "called before init()" and wired capture and the page API to a client
  that records nothing, with no visible error. Grant after a revoke now
  re-initialises a fresh, consented client and re-wires the visit's served goal
  listeners to it. The fresh client deliberately means a fresh visitor identity:
  revocation cleared the identity cookie because forgetting the visitor is the
  point of revoking, so resuming must not resurrect the severed id.
- 2f5d3ac: The scroll_depth goal listener now actually removes itself once every scroll
  goal has fired. The self-removal check compared bare goal ids against a set
  that only ever holds composite wiring keys, so the condition was always false
  and the handler kept running on every scroll for the rest of the page's life.
  Dedupe behaviour is unchanged — this only stops the leaked work.

## 0.17.1

### Patch Changes

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

## 0.17.0

### Minor Changes

- 28352a0: Composition Blocks, Phase 1 (Track B2 — spec 2026-08-20 §4/§6).

  Core exports the Composition Block schema: a bounded, typed component tree (`stack`, `grid`, `text`, `heading`, `button`, `link`, `image`, `badge`, `spacer`) whose every prop is an enumerated token — never HTML, never raw CSS. Registry arms may carry a `blocks` tree in `published_config`; the server total-validates each tree at publish (node vocabulary, tokens, https-only URLs, required alt text, depth/node/children caps, ≤ 4 arms with blocks per slot) and serves ALL arms' trees in `slotConfig.blocks` — holdout sessions receive the baseline arm's tree only.

  The snippet renders trees via `createElement` exclusively (no sanitizer because no HTML is ever accepted) using Option B: every arm pre-renders hidden inside the slot container, the served arm is revealed by arm id, and the container's original children are stashed/restored exactly — so structural variants are pre-paint safe and a stale snapshot's reveal is corrected by a toggle, not a re-render. Always-on bundle re-baselined 18 → 20 KiB gzip for the renderer (measured 19,558; documented in size-check.ts).

  Grids render responsive by construction: `auto-fit` columns with an exact cap at the declared count, collapsing on narrow screens — arrangements never author breakpoints.

  No editor yet — arms are authored via the slot-definitions API (the v1 arrangement catalog ships server-side: list + instantiate under mgmt `composition-arrangements`).

  Palette derivation ("derived, not chosen"): the on-site editor overlay samples the site's dominant button look (background, text color, radius) on each open and stores it server-side; registry decisions carrying blocks serve it back, the snapshot caches it, and the renderer brands `emphasis: 'primary'` buttons and corner radius from it — neutral inherit-first defaults when no palette is stored.

- 47584a5: Snippet section reordering (Track B1.1) and vocabulary-validated persona preview (B1.2).

  `window.sentient.sections: ['#hero', '#pricing', '#faq']` declares the page sections eligible for adaptive reordering, as CSS selectors in the theme's natural order — mirroring the React `sections` prop. Selectors that resolve on the page ride the existing decide call, and the served `layoutOrder` is applied only under fail-safe bounds: every id must resolve to exactly one element, all elements must share one parent, and the order must be a permutation of what can move — anything else applies nothing, silently. Return visits pre-paint the last served order from the local snapshot (bounded against the current DOM), so a learned layout doesn't flash natural-order first.

  The `?sentient_persona=` preview banner now trusts the server's vocabulary echo: a recognized key shows its display name; an unrecognized value says "isn't in your personas — showing the default experience" instead of claiming a persona `/v1/explain` never simulated.

## 0.16.1

### Patch Changes

- 5bae186: Document the declared-persona surface shipped in the previous release: `init({ persona })`, the `persona` prop on `<AdaptiveRoot>`/`<AdaptiveProvider>`, and `window.sentient.persona` (string or function form) now appear in each package README, and the MCP integration guide explains per-project persona vocabularies and declaration instead of the old fixed four-persona list.

## 0.16.0

### Minor Changes

- 2ef60e1: Declared personas: tell the engine the role your app already knows, and the layout/slot optimizer learns per role.

  - **core**: `init({ persona: 'admin' })` — sent on the session upsert and every decide; SSR helpers (`preloadAssignments`/`preloadDecisions`) accept the same option. Declared personas are served at full confidence, overriding the inferred one; values not in the project's persona vocabulary are ignored server-side and surfaced in the dashboard.
  - **react**: `persona` prop on `<AdaptiveProvider>`/`<AdaptiveRoot>`, forwarded through both SSR paths. Stable for the session (decisions are locked per visit); changing it after init warns in dev.
  - **snippet**: `window.sentient.persona` — a vocabulary key string, or a function evaluated once at init (fail-safe: a throwing or non-string getter is treated as undeclared).
  - **policy**: new `resolvePersona` (declared beats inferred), `decisionPersona`, `DEFAULT_PERSONA_VOCABULARY`, `PERSONA_KEY_RE`, `RESERVED_PERSONA_KEYS`; the layout heuristics accept any vocabulary persona (custom personas cold-start on the natural order, like `unknown`).

## 0.15.1

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

## 0.15.0

### Minor Changes

- 1ce4b77: The snippet now records which page each visit is on, and emits a `pageview` event
  on load and on every SPA route change. This adds a small amount of network
  traffic that was not there before.

  Only `location.pathname` is sent — never the full URL or query string, so emails,
  reset tokens and order ids that sites routinely put in URLs never leave the
  browser.

  This behaviour is inherited from the bundled `@sentientui/core`, which the
  snippet compiles in rather than depending on at runtime — hence the explicit
  version bump here, since a dependency bump alone would not have produced a
  changelog entry for a visible change.

  Requires migration 108 on the API side. Against an older API the events are
  accepted and the path is simply not stored.

## 0.14.1

### Patch Changes

- 6cfe1c2: No-code goals now dedupe once per SESSION, as documented, instead of once per
  page load.

  The guard was a `Set` held in a closure, which resets on every page load — and
  the snippet targets multi-page sites (Webflow, WordPress, Shopify themes) where
  every navigation reloads the page and reinstalls the listeners. A page-visit
  goal on `/pricing` therefore fired on every visit to `/pricing`, and nothing
  deduplicated it server-side either. Training was insulated (close-out caps
  per-goal credit at `min(1, Σ)` and funnel reach counts distinct sessions), but
  the Hits column is a `COUNT(*)` and inflated without limit.

  Dedupe now lives in `sessionStorage`. It degrades to per-page dedupe when
  storage is blocked and ignores a corrupt bucket rather than throwing. The scroll
  listener also detaches once every scroll goal has fired.

## 0.14.0

### Minor Changes

- 6dade33: `scroll_depth` goals: registry-mode sites can now count "read this far" as a conversion. The snippet installs a passive scroll listener that fires the goal once per session when the page has been scrolled past the goal's threshold (short pages already past it fire at install), and the on-site editor gains a "Track reading this far as a goal" button with a 25/50/75/90% depth picker.

## 0.13.0

### Minor Changes

- 32996be: `SentientSnippet.goal(name, { value, currency, externalId })` records revenue conversions, with a pre-boot queue stub (`window.SentientSnippet = window.SentientSnippet || { q: [], goal: function () { this.q.push(['goal'].concat([].slice.call(arguments))); } }`) for calls made before the snippet loads.

## 0.12.0

### Minor Changes

- c55ae50: On-site editor: pause/resume element selection so you can browse the site normally mid-session; per-variant preview mode (`?sentient_preview=<slotId>&sentient_arm=<armId>` on an editor-token link) that renders a component with a chosen variant injected, with an on-page variant switcher; font variations — `fontFamily` joins the bounded style vocabulary (web-safe stacks + fonts the site already loads, never loading new font files), with a Font field in the style form.

## 0.11.5

### Patch Changes

- 8ecd00f: Point `repository` metadata at the public source mirror (`github.com/SentientUI/sdk`)
  so the "Repository" link on npm resolves, and add a `bugs` URL for issue reporting.
  No runtime changes.

## 0.11.4

### Patch Changes

- 0da8854: Locator and editor hardening from the snippet SDK audit:

  - `resolveLocatorOne` now validates a compound locator's `dataAttr.name` against
    a safe attribute-name pattern before interpolating it into a selector (the
    value was already escaped). Unsafe names are skipped rather than relying on
    `querySelectorAll` throwing — defense in depth for server/editor-supplied
    locators.
  - The editor's `CSS.escape` fallback (ancient engines without `CSS.escape`) now
    escapes a leading-digit id to the CSSOM code-point form (`\3N `) instead of
    emitting an invalid `#2hero` selector that would never resolve back.
  - Editor overlay DOM insertions now fall back to `documentElement` when
    `document.body` is absent, matching the snippet-side notices.
  - The on-site "Test different text here" option is now offered only for leaf /
    text-only elements. It applies via `el.textContent`, so arming it on a
    container (e.g. `<h1>Get <span>started</span></h1>`) would flatten the child
    markup to plain text for every visitor; containers now get a disabled button
    with an explanatory tooltip. Style and goal actions are unaffected.
  - Editor style edits are now validated per property (unit required on
    `fontSize`/`borderRadius`, keyword whitelist for `textAlign`, colour check)
    and rejected with inline per-field feedback instead of a false "✓ Saved" for
    values the browser silently drops (`fontSize:"20"`, `textAlign:"centre"`,
    `color:"reddish"`). The colour controls are now `<input type="color">` and
    alignment is a `<select>`, so most illegal values can no longer be entered.
  - The CSS whitelist + value guard are unified in a single `css-guard` module
    shared by the runtime ops engine and the editor (previously hand-duplicated
    and diverged). The runtime guard now also rejects empty/whitespace values, so
    a server-delivered `{color:''}` no longer produces a degenerate
    `color: !important` rule.
  - The `CSS.escape` fallback now also escapes a digit in the second position
    after a leading `-` (`-1x` → `-\31 x`) and a lone `-`, matching `CSS.escape`
    (previously only a digit at index 0 was handled, so `#-1x` was emitted
    invalid).
  - Closing the on-site editor now nulls `window.__sentientEditor` (which held the
    raw bearer token in memory) and removes the injected
    `<meta name="referrer" content="no-referrer">`, instead of leaving both behind
    after teardown.

  Internal: the always-on bundle's size budget is re-baselined 15→16 KB gzip to
  reflect the shipped feature set and is now enforced in CI (it previously drifted
  over an unenforced limit). `scripts/size-check.ts` now also budgets the lazily
  loaded editor overlay bundle (12 KB gzip) so it can't grow unbounded.

## 0.11.3

### Patch Changes

- cb11a47: Consent-lifecycle and safety fixes in the embed script:

  - `grantConsent()` now starts section/slot-signal capture for visitors who consent after load (previously capture stayed dark until a full reload).
  - `revokeConsent()` now tears down goal listeners so they no longer fire on a destroyed client.
  - The CSS value guard rejects `url()` and other functions (whitelisting only `rgb`/`rgba`/`hsl`/`hsla`/`calc`/`var`/`min`/`max`/`clamp`), closing an external-resource-load vector from stored style ops.
  - SPA navigation now always tears down the previous page's slot-signal detectors, even when the new route applies no slots.

## 0.11.2

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

## 0.11.1

### Patch Changes

- 47a0306: Fix per-option behavior signal accuracy:

  - Re-attach per-option detectors after SPA navigation / hydration so tagged
    signals keep flowing for the rest of the visit instead of stopping when the
    DOM is replaced under the original detectors.
  - Emit `tab_loss` once per session instead of once per applied option, so a
    single tab-hide no longer inflates "quick exits" for options the visitor
    never looked at.
  - Guard against double-initialization when the tag is loaded twice (e.g. Google
    Tag Manager plus a hardcoded embed), which previously doubled decide calls,
    goal listeners, and signal counts.
  - Stop reporting the `0.0.0-dev` sentinel version, so non-tsup builds are no
    longer persisted as the project's snippet version and flagged as an outdated
    embed.

## 0.11.0

### Minor Changes

- 1686fd3: Behavior signals (frustration clicks, quick exits, reading pauses, text copied, long hovers) are now also tagged with the no-code component option they happened on, powering the dashboard's per-option "How visitors behave" view. Section-level capture is unchanged.

## 0.10.1

### Patch Changes

- 150cd26: Parse snippet slot/persona specs by splitting on the first colon only, so spec values may themselves contain colons (e.g. `hero:label=a:b`) without being truncated.

## 0.10.0

### Minor Changes

- b3ca7b8: On-site editor overhaul: a persistent selection ring + "Selected: …" label so the chosen element never gets lost while using the panel; actions grouped under Content & style / Track a goal / Move (hidden until something is selected); goal tracking beyond clicks — form submissions (auto-detected) and page visits — saved in one click with no name field (an id is derived from what's tracked, unique per element); goals can now be activated in-editor via "Start tracking now" (mirroring slots' save → publish); moved elements scroll into view and disabled move directions explain why.

## 0.9.0

### Minor Changes

- 28fe1d4: The on-site editor can now publish a saved change live without a dashboard round-trip. After saving a text/style/move draft, a "Publish now — go live" button promotes it via a new token-authed `POST /v1/editor/slots/:slotId/publish` endpoint. Published content stays bounded and server-validated (plain text, whitelisted style ops, https-only URLs) and is versioned, so every publish is reversible from the dashboard and recorded in the decision ledger. Goals still save as drafts; pins and analytics remain dashboard-only.
- 28fe1d4: Add an event-free "preview as persona" mode to the no-code snippet. Opening a site with `?sentient_persona=<key>` now simulates what that audience is served via the read-only `/v1/explain` endpoint — no `init`, no tracking, and no snapshot write, so it never pollutes the site's own analytics. Registry-mode sites ask the server for their published slots; declared-slot sites send their own. A fixed "Previewing as X · Exit preview" affordance makes the simulated state obvious and reversible. Powers the dashboard "Preview as this audience" action from the Audiences page.

## 0.8.1

### Patch Changes

- 1487308: Harden the no-code on-site editor load path. A failed editor-bundle load or a non-401 verify error now surfaces a toast (or a snippet-side notice when the bundle never loads) instead of a blank page, and the editor token is cached in sessionStorage so a reload — or same-site navigation — re-enters editor mode without reopening the dashboard. The token is still stripped from the URL immediately and the cache is cleared on close or on an expired (401) session.

## 0.8.0

### Minor Changes

- c90b60a: On-site editor: in-panel forms, richer editing, and reliable section reordering.

  - **No more native prompts**: the "Test different text", "Track clicks as a goal", and new "Change style" actions now open styled fields inside the editor panel instead of jarring `window.prompt()` dialogs. You're also no longer asked to invent a "slot id" — one is generated automatically from the element.
  - **Style editing**: adapt an element's text colour, background, font size, font weight, corner radius, and alignment directly on your site, saved as a draft A/B test (published from your dashboard). Values are bounded to a safe, whitelisted set.
  - **Reliable Move up/down**: sections can now be nudged multiple positions in one session, and reordering several different sections no longer overwrites earlier ones — each is saved as its own draft. The anchor is recomputed after every move so the saved arrangement matches what you see.

  All edits remain drafts only (never auto-published), and no HTML/JS injection is possible — text is applied via `textContent` and styles via a bounded, validated set.

## 0.7.0

### Minor Changes

- 19663e3: On-site editor: make it obvious it's on, and handle an expired token gracefully.

  - **Prominent on load**: the editor panel now slides in with a brief indigo halo pulse and shows a live status dot, so opening `?sentient_editor=<token>` no longer looks like "just my site." All motion respects `prefers-reduced-motion`.
  - **Expired-session feedback**: if the short-lived editor token is expired/invalid, the overlay shows a dismissible "Editor session expired — reopen it from your dashboard" notice on load (instead of silently doing nothing), and a save attempted after expiry says the session expired rather than the misleading "try again." Already-saved drafts are unaffected. Only a real `401` triggers this — a transient network error stays silent.

## 0.6.0

### Minor Changes

- 6a09ead: Consume the server-classified section map from /v1/decide: sections resolve via the slot locator machinery and type the engagement capture, so persona traits populate on pages with no data-sentient-type tagging.

## 0.5.0

### Minor Changes

- 2c6420b: Personas now work out of the box. **Behavior change:** DOM graph scanning (`enableGraph`) and behavioral engagement capture (per-section dwell/scroll + semantic section detection) are now ON by default in the React provider, and `sectionCapture` is ON by default in the no-code snippet. Opt out with `enableGraph={false}` / `engagement={false}` (React) or `sectionCapture: false` (snippet). Do-Not-Track, Global Privacy Control, and consent gates are unchanged and always win. Also: semantic types are auto-detected for untagged sections (explicit `data-sentient-type` still takes precedence) and invalid explicit types are normalized instead of breaking graph sync.

## 0.4.0

### Minor Changes

- 5d2e0ad: Richer no-code slot ops: reorder + expanded styles.

  - **core**: `SlotOps` gains `moveBefore`/`moveAfter` (reposition an element relative to a uniquely-resolving sibling anchor); the decide input accepts an optional `v` (embedded snippet version) that is forwarded on the wire so the dashboard can flag out-of-date embeds.
  - **snippet**: the apply engine adds a fail-safe reorder op (unresolved/ambiguous/cross-parent anchors apply nothing and report a locator miss; post-decide only, never pre-paint) and 10 new whitelisted style properties (`width`, `height`, `maxWidth`, `border`, `boxShadow`, `opacity`, `lineHeight`, `letterSpacing`, `textTransform`, `gap`). The on-site editor gains Move up / Move down authoring and audit-target pre-highlighting, and the snippet now reports its version on decide.

## 0.3.0

### Minor Changes

- e69dfe1: No-code adaptive registry: serve dashboard-defined slots and goals from the snippet, with bounded ops, compound locators, and an on-site editor.

  - **Registry mode** (`slotsFrom: 'registry'`): a bare `window.sentient = { apiKey }` install adapts the project's published dashboard slots automatically. `decide()` returns `slotConfig` (target/kind/content/ops) and editor-defined `goals`; the snapshot carries them for return-visit pre-paint.
  - **Bounded ops**: registry arms can apply a whitelisted style set + text/href/image via a generated `!important` stylesheet — never innerHTML, never arbitrary CSS/JS.
  - **Compound locators**: `id → data-attr → selector` resolution with fingerprint verification; zero/ambiguous/fingerprint-fail means no change (never guesses). Unresolved slots report a `locator_miss` so the server can auto-suspend broken slots.
  - **Editor-defined goals**: click / form-submit / URL-reached goals delivered with the decision; the snippet installs delegated listeners that fire the existing `goal()` / `componentGoal()` paths.
  - **On-site visual editor**: `?sentient_editor=<token>` loads a separate overlay bundle (zero bytes on the normal path) to pick elements and save drafts; the token is stripped from the URL immediately.
  - **Section capture** (`sectionCapture: true`): opt-in, records per-section dwell/scroll to power the persona × section matrix for no-code sites. Reuses the existing event pipeline and is hard-gated on the DNT/GPC + consent state — it never runs for an opted-out visitor.
  - New snippet config passthrough: `consent`, `preConsentBehavior`, `debug`, `registry`, `editorSrc`, `apiBase`, `sectionCapture`.

## 0.2.2

### Patch Changes

- 73f7c59: README: drop the claim that each release's SRI hash is published in release notes — compute the hash from the published file to pin.

## 0.2.1

### Patch Changes

- ee39693: Fix the README install URL and the `version` export, which still referenced the
  never-published 0.1.0 (the unpkg URL 404'd). Also resolves workspace deps to
  source in the test config so CI tests no longer require a prior build.

## 0.2.0

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
