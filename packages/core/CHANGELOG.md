# @sentientui/core

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
