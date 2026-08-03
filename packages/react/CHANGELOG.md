# @sentientui/react

## 0.18.5

### Patch Changes

- de26748: Re-export `agentIntent` / `classifiedAgents` (and the `AgentIntent` type) from the server entry `@sentientui/react/next`, so server components can classify agent traffic with a single SDK import.
- Updated dependencies [de26748]
  - @sentientui/core@0.16.9

## 0.18.4

### Patch Changes

- 25821a1: Fix: `matchedAgentToken` / `uaTokenMatch` are re-exported from the **server** entry `@sentientui/react/next` instead of the client index. Re-exporting a plain function through the `'use client'` package index turned it into a client reference that threw "client function called from the server" when a Server Component called it during SSR. Server-side agent detection should import from `@sentientui/react/next` (alongside `AdaptiveRoot`).

## 0.18.3

### Patch Changes

- 8663750: `AdaptiveRoot` now captures JS-less AI-assistant fetches server-side: when a request's user-agent matches a known agent (GPTBot, ChatGPT-User, Claude-User, PerplexityBot, …), it logs the fetch to your agent analytics (fire-and-forget, no cookie, no session). Add `captureAgents={false}` to opt out. The standalone `sentientAgentMiddleware` export is removed — `AdaptiveRoot` supersedes it, so agent capture now happens on any page that renders `AdaptiveRoot`.
- 8663750: CSP: `SentientPersonaScript` and `AdaptiveRoot` accept a `nonce` for their inline persona / JSON-LD scripts, so strict `Content-Security-Policy` deployments that block `'unsafe-inline'` can allow them explicitly. Privacy: `AdaptiveProvider` gains `captureDomText` (off by default) to opt into sending captured heading/DOM text in graph sync. Fix: escape the NUL byte in `adaptive.tsx` (the file is plain text again). DX: re-exports `matchedAgentToken` / `uaTokenMatch` from `@sentientui/core`, so agent detection needs only the single `@sentientui/react` import.
- Updated dependencies [8663750]
- Updated dependencies [8663750]
  - @sentientui/core@0.16.8

## 0.18.2

### Patch Changes

- 8ecd00f: Point `repository` metadata at the public source mirror (`github.com/SentientUI/sdk`)
  so the "Repository" link on npm resolves, and add a `bugs` URL for issue reporting.
  No runtime changes.
- Updated dependencies [8ecd00f]
  - @sentientui/core@0.16.7
  - @sentientui/policy@0.3.3

## 0.18.1

### Patch Changes

- 0da8854: Adaptive SDK consistency + override hardening:

  - `useAdaptiveGoal` now honors the dev override channel (`?sentient_variant=` /
    `window.__sentient_overrides`): a forced component no-ops both `componentGoal`
    and `goal`, so live QA no longer pollutes the bandit or the session funnel —
    matching `useAdaptive.fireGoal` and the declarative `<Adaptive goal>` path.
  - Unified variant-id memoization across `<Adaptive>`, `useAdaptive`,
    `AdaptiveGroup`, and `useAdaptiveTokens`: the declared set is now frozen on a
    stable key derived from its members. `<Adaptive>` with an inline
    `variants={{...}}` literal no longer churns a new array every render, so it
    stops unregistering + re-registering the component on each commit.
  - `<Adaptive>` micro-signal (and cursor-signal) capture is now gated on
    `settled` like the exposure event, so a rage-click / tab-loss during the
    pre-`assign()` window can no longer record a `micro_signal` or fire a mapped
    named goal against the interim baseline arm.
  - `useAdaptiveTokens` goal binding now uses `CSS.escape` with a hardened
    fallback (escapes `\\` and `"`), so CSS-special slot ids resolve to the right
    element.
  - Provider now emits a dev-only warning when a session-frozen prop
    (`apiKey` / `context` / `country` / `apiBaseUrl`) changes after init, making
    the deliberate no-op visible instead of silent.
  - Documented that `<Adaptive>` `agentData` / `agentDataByVariant` are captured
    at mount, and strengthened the `useAssignment` deprecation to steer toward
    `useAdaptive`.

- Updated dependencies [0da8854]
- Updated dependencies [0da8854]
  - @sentientui/policy@0.3.2
  - @sentientui/core@0.16.6

## 0.18.0

### Minor Changes

- cb11a47: New `useAdaptivePersona()` hook (and `AdaptivePersona` type) exposing the current persona estimate — a forced override (devtools / `applyScenario` / `?sentient_persona=`), the SSR `initialPersona`, or the live client estimate — resolved hydration-safely.

  Also includes several fixes:

  - `AdaptiveRoot` (Next.js) now threads a custom `apiBaseUrl` into the SSR decide/assign calls, so SSR and the client hit the same API host (previously self-hosted deployments lost SSR→client session continuity).
  - Slot goals (`useAdaptiveTokens`, `AdaptiveGroup`) and manual goals (`useAdaptiveGoal`, `useAdaptive().fireGoal`) now also write the session goal-funnel record, so slot conversions appear in the funnel like `<Adaptive>` conversions (no change to bandit reward — no double count).
  - Forced slot arms (`__sentient_slot_overrides`) now suppress exposure and goals, matching the component-override contract.
  - `AdaptiveText` now honors dev overrides (`?sentient_variant=` / `__sentient_overrides`), suppressing assign/exposure/goals for a forced variant.
  - Dev overrides are read via `useSyncExternalStore`, eliminating a remount race that could fire a stray `assign()`/exposure before the override applied.
  - The devtools registry is a no-op in production builds (no `window.__sentient_registry` footprint).
  - `applyScenario`/`resetScenario` now notify subscribed hooks so forcing state mid-session re-renders immediately.
  - `useAssignment` computes its initial state via a lazy initializer (once per mount, not every render); `apiBaseUrl` from the provider is trailing-slash normalized.

### Patch Changes

- Updated dependencies [cb11a47]
  - @sentientui/core@0.16.5

## 0.17.3

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

- Updated dependencies [f27780c]
  - @sentientui/core@0.16.4

## 0.17.2

### Patch Changes

- Updated dependencies [47a0306]
  - @sentientui/core@0.16.3

## 0.17.1

### Patch Changes

- 150cd26: Gate the dev-override diagnostic log behind the provider's debug flag and move it into an effect, so it never runs during render or in production.
- Updated dependencies [150cd26]
- Updated dependencies [150cd26]
  - @sentientui/core@0.16.2
  - @sentientui/policy@0.3.1

## 0.17.0

### Minor Changes

- 28fe1d4: `<AdaptiveText>` gains an optional `goal` prop so dashboard-managed copy can be optimized, not just rotated. Without a goal the variant is served and logged (`variant_assigned`) but never scored; with one, conversions attribute to the winning wording via the same goal machinery as `<Adaptive>`. Documented that managed variants are **text-only** — they change the wording, never the CSS, markup, or layout; use `<Adaptive>` (or code) for structural changes.

## 0.16.3

### Patch Changes

- Updated dependencies [b4fcf4a]
  - @sentientui/core@0.16.1

## 0.16.2

### Patch Changes

- Updated dependencies [6a09ead]
- Updated dependencies [6a09ead]
  - @sentientui/policy@0.3.0
  - @sentientui/core@0.16.0

## 0.16.1

### Patch Changes

- 14f27e5: Remove `previewHtml` capture from the SDK. `<Adaptive>`, `useAdaptive`, `useAdaptiveTokens`, and `<AdaptiveGroup>` no longer serialize the rendered container's `innerHTML` into the `variant_assigned` event payload — exposure events are now empty-payload. As a result, exposure fires as soon as a variant is assigned instead of waiting for non-empty DOM, so a variant that renders empty content is now recorded (previously it was never counted toward optimization).

## 0.16.0

### Minor Changes

- 2c6420b: Personas now work out of the box. **Behavior change:** DOM graph scanning (`enableGraph`) and behavioral engagement capture (per-section dwell/scroll + semantic section detection) are now ON by default in the React provider, and `sectionCapture` is ON by default in the no-code snippet. Opt out with `enableGraph={false}` / `engagement={false}` (React) or `sectionCapture: false` (snippet). Do-Not-Track, Global Privacy Control, and consent gates are unchanged and always win. Also: semantic types are auto-detected for untagged sections (explicit `data-sentient-type` still takes precedence) and invalid explicit types are normalized instead of breaking graph sync.

### Patch Changes

- Updated dependencies [2c6420b]
  - @sentientui/core@0.15.0

## 0.15.6

### Patch Changes

- 7f3d9c6: Add `homepage`, `repository`, and `keywords` to package metadata so the packages are discoverable from the SentientUI brand on the npm registry and link back to the docs and source.

## 0.15.5

### Patch Changes

- Updated dependencies [5d2e0ad]
  - @sentientui/core@0.14.0

## 0.15.4

### Patch Changes

- 55c99bd: Fix `<Adaptive>` freezing dynamic variant content. The memo comparator only compared variant **keys**, so dynamic values inside a variant (e.g. `<Price value={price} />`) rendered once and then never updated when the value changed — the assigned variant id is stable, so nothing triggered a re-render. The comparator now also compares the variant node values (by reference) and the `clientOnly` / `agentData` / `agentDataByVariant` props.
- Updated dependencies [55c99bd]
  - @sentientui/core@0.13.1

## 0.15.3

### Patch Changes

- Updated dependencies [e69dfe1]
  - @sentientui/core@0.13.0

## 0.15.2

### Patch Changes

- 6794bb7: Honor Do Not Track and Global Privacy Control everywhere, and stop minting visitor identity for opted-out visitors.

  - **GPC**: `navigator.globalPrivacyControl` (and `Sec-GPC: 1` on the server) is now treated as a tracking opt-out alongside DNT. GPC is the legally-enforceable CCPA/CPRA signal and was previously ignored.
  - **Keyless / local mode** no longer writes the 365-day `_snt_uid` cookie for a DNT/GPC visitor — the opt-out is now evaluated before the local-mode branch, which used to call `initSession()` unconditionally.
  - **Graph mode** (`@sentientui/core/graph`) no longer mounts the DOM scanner or POSTs page structure / reads `_snt_uid` for an opted-out visitor, even under `preConsentBehavior: 'statistical_winner'`.
  - **SSR**: `preloadAssignments` / `preloadDecisions` gain a `doNotTrack` option that skips the session upsert and the assign/decide call, so no session row is minted server-side for an opted-out visitor. `@sentientui/react`'s `<AdaptiveRoot>` sets it automatically from the `DNT` / `Sec-GPC` request headers, and `loadAdaptiveAssignments` / `loadAdaptiveDecision` forward it.

- Updated dependencies [6794bb7]
  - @sentientui/core@0.12.1

## 0.15.1

### Patch Changes

- 73f7c59: `<AdaptiveRoot>`'s `components` prop is now optional (defaults to `[]`) — the documented minimal setup previously crashed the server render when the prop was omitted. `<AdaptiveProvider>`'s effect cleanup now calls the new `dispose()` instead of `destroy()`, so unmount/re-init (including React StrictMode's dev double-invoke) no longer deletes the visitor identity; the explicit consent-revocation path still fully destroys. Also fixes the Pages Router SSR example in the README: `loadAdaptiveAssignments` returns `{ assignments, sessionId }`, and both must be passed (`initialAssignments` + `ssrSessionId`) or the preload silently does nothing and events attach to the wrong session.
- Updated dependencies [73f7c59]
  - @sentientui/core@0.12.0

## 0.15.0

### Minor Changes

- c37feb3: Dev overrides (`?sentient_variant=` / `window.__sentient_overrides`) now record nothing while a variant is forced — no exposure events, no goals, no micro-signals — in both `<Adaptive>` and `useAdaptive`, so browsing with an override can no longer train the optimizer on the forced variant. `AssignmentState` gains an optional `isOverride` flag. Also corrects the README: opt-in consent wiring (the SDK defaults to `consent: true`), the CLI init scaffold's manual wrap-and-mount step, and the `SentientPersonaScript` requirement for Rung-1a persona attributes in non-Next apps.

### Patch Changes

- Updated dependencies [c37feb3]
  - @sentientui/core@0.11.2

## 0.14.3

### Patch Changes

- Docs: correct the install command from `npx sentientui init` to `npx @sentientui/cli init`. The published package is scoped, so the bare `sentientui` name 404s on npm. Updates the CLI usage/help text and package description, the MCP integration guide, and the `llms.txt` agent-facing docs.
- Updated dependencies
  - @sentientui/core@0.11.1

## 0.14.2

### Patch Changes

- Devtools now picks up registry changes under Next Fast Refresh without a hard refresh.

  The panel subscribed to the component/slot registry with a manual `useEffect(() => subscribeRegistry(force), [])`. Across Fast Refresh that empty-deps effect never re-subscribed and its listener could go stale, so renaming a component/slot id updated the app but left the devtools showing the old id until a full page reload. The subscription now uses `useSyncExternalStore` (a monotonic registry version), which React re-subscribes and re-reads correctly across hot reloads.

## 0.14.1

### Patch Changes

- Devtools fixes: slot overrides, live component overrides, and SSR-safe mounting.

  - **Slots are now controllable from the devtools.** `useAdaptiveTokens` and `AdaptiveGroup` were registered as fake components, so their panel buttons wrote the variant-override channel (`__sentient_overrides`) that slots never read. They now render in a dedicated **Slots** section that writes correctly-shaped results to `__sentient_slot_overrides` (a token object for dims slots, an arm string for arms slots) and re-render live.
  - **Component overrides re-render immediately.** `useAssignment` (behind `<Adaptive>` / `useAdaptive`) read `__sentient_overrides` only at mount and never subscribed to change events, so forcing a variant from the panel had no effect until an unrelated re-render. It now subscribes via `useSyncExternalStore`, mirroring `useSlotResult`.
  - **`<AdaptiveDevtools>` is SSR-safe.** It renders nothing until it mounts on the client, so it no longer needs a `dynamic(() => …, { ssr: false })` wrapper — import and render it directly.

## 0.14.0

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
  - @sentientui/core@0.11.0
  - @sentientui/policy@0.2.0

## 0.12.1

### Patch Changes

- Lower the default SSR preload `timeoutMs` from 1500 ms to 1000 ms in `preloadDecisions`/`preloadAssignments` and `<AdaptiveRoot>`.

  A decide served from the API's in-process cache typically returns in well under 150 ms; the full 1 s budget is only reached on a cold start or an API geographically distant from your SSR host, after which default variants render with no layout shift. Override `timeoutMs` if your API is co-located and warm (the SentientUI site itself uses 400 ms).

- Updated dependencies
  - @sentientui/core@0.9.1

## 0.12.0

### Minor Changes

- Add `@sentientui/react/testing` — a testing toolkit that makes adaptive UI deterministic across Jest, Vitest, React Testing Library, Playwright, and Cypress.

  - **`renderWithSentient(ui, scenario)`** — render a component with SentientUI serving the control variant + default layout by default (no network), or force specific `variants`/`layout`.
  - **`setupSentientServer()`** — an MSW-backed mock backend for every SDK endpoint, with API error/latency injection and event capture (`getSentientEvents`, `hasFiredGoal`).
  - **`mockSentient(page, scenario)`** (Playwright) and **`mockSentientCypress(cy, scenario)`** — force variants/layout, stub the API, and capture events in E2E.
  - New `window.__sentient_layout_override` primitive so layout order can be pinned synchronously in tests (analogous to the existing `__sentient_overrides` for variants).

  All helpers write nothing to the real API. `msw` and `@testing-library/react` are optional peer dependencies.

## 0.11.0

### Minor Changes

- Add `@sentientui/react/devtools` — a dev-mode floating widget (React Query Devtools model) to verify your integration and preview it with no data written.

  - **Wired-up inspector:** lists the `<Adaptive>` components on the page with their variants and goals.
  - **Variant preview:** force any component to any variant live, using the existing `window.__sentient_overrides` hook.
  - **Persona preview:** force a persona via the new `POST /v1/explain` endpoint and watch the layout/assignments change.
  - **Writes nothing:** preview mode swaps in an event-suppressing client, so no `variant_assigned`, goals, or session events are sent.

  Ships as an opt-in subpath export, `NODE_ENV`-guarded so production bundles ship zero devtools UI.

## 0.10.0

### Minor Changes

- f3ea544: Honor the browser's Do Not Track (DNT) signal. New `respectDoNotTrack` config option (default `true`) on `init()` and the React `AdaptiveProvider`. When a visitor has DNT enabled, the SDK sets no cookies and sends no tracking data — overriding `consent: true` and preventing `grantConsent()` from re-enabling tracking. If `preConsentBehavior: 'statistical_winner'` is set, the read-only winner is still served (nothing stored). Set `respectDoNotTrack: false` to make your own consent gate authoritative. Also exports `isDoNotTrackEnabled()` from core.

  This aligns the SDK's behavior with the Do Not Track claim already in the cookie disclosure. Note DNT is a supplementary opt-out, not a replacement for the `consent` gate — opt-in consent is still required for EU/California visitors.

### Patch Changes

- Updated dependencies [f3ea544]
  - @sentientui/core@0.9.0

## 0.9.0

### Minor Changes

- Add an `enableGraph` prop to `AdaptiveProvider` (and `AdaptiveRoot`). When set,
  the provider loads `@sentientui/core/graph` on demand and uses its graph-capable
  `init()` for the single client, enabling DOM graph scanning + sync that powers
  the dashboard Graph page. Off by default, so lean consumers keep their bundle size.

## 0.8.5

### Patch Changes

- f30989a: Fix `@sentientui/react/next` shipping a duplicate React context, which broke all client-side tracking under `<AdaptiveRoot>`.

  `adaptive-root-client.tsx` imported the provider via a relative path (`../provider.js`), so tsup inlined a second copy of `provider.js` into the `/next` bundle. That second copy ran `createContext()` again, producing a distinct `AdaptiveContext`. As a result `<AdaptiveRoot>` populated one context while `useSentient()` / `<Adaptive>` (from the main entry) read a different one that stayed `{ client: null }` forever — variant serving still worked (assignments resolve server-side), but no `variant_assigned`, goal, or micro-signal event ever left the browser because every effect bailed at `if (!client) return`.

  The `/next` client boundary now imports `AdaptiveProvider` from the package entry (`@sentientui/react`, already `external` in the build), so both entries share the single context singleton and interactive tracking works under `<AdaptiveRoot>`.

## 0.8.4 — 2026-07-01

### Added

- **`useAdaptiveGoal(componentId)`** hook — returns a `fireGoal(goalType, opts?)` callback that records a conversion attributed to the served variant for `componentId` (via the new core `componentGoal()`), with no manual `variantId`/`projectId` plumbing. Use it for imperative handlers (click, form submit, custom events) instead of hand-rolled `client.track({ eventType: 'goal_achieved', … })` helpers. `opts` accepts `reward` (0–1, default 1) and `metadata`.
- **`FireGoal` type** exported from `@sentientui/react`.

### Fixed

- **Goal rewards not reaching the bandit for click/composite/form_submit goals** — `fireGoal()` called `client.track()` (events queue) but not `client.goal()` (the `/v1/goals` endpoint that updates bandit weights). Only `weighted_composite` goals called both. Regular click, form_submit, and composite goals were recording the `goal_achieved` event but never feeding the reward signal to the bandit. Fixed by adding `client.goal()` to `fireGoal()`.
- **`goalFiredRef` not reset when `goal` prop changes** — if a parent changed the `goal` prop while the component stayed mounted with the same `variantId`, the new goal listener was attached but the latch was already `true`, silently preventing the new goal from ever firing. `goal` is now included in the latch-reset effect's dependency array.
- **`previewHtml` captured as empty string on first paint** — the impression-tracking effect set `assignTrackedRef` unconditionally, even when `containerRef.current.innerHTML` was empty (async content not yet rendered). The latch prevented any retry in the same session. The effect now returns early when `rawHtml` is empty and retries on the `mounted` state change, when content is guaranteed to be in the DOM.

### Updated dependencies

- `@sentientui/core@0.8.2` — `track()` sessionReady gate; `componentGoal()` (backs `useAdaptiveGoal`)

---

## 0.8.3 — 2026-06-30

### Fixed

- **`serverApiKey` removed from `<AdaptiveRoot>`** — both it and `apiKey` are `pk_` public keys, so there was no functional distinction. `<AdaptiveRoot>` now uses `apiKey` for all requests. Remove `serverApiKey` from your JSX and delete `SENTIENT_API_KEY` from your env — `NEXT_PUBLIC_SENTIENT_API_KEY` is all you need.
- **`onAssignment` removed from `AdaptiveRootProps`** — the prop was listed on the RSC component but function callbacks can't be serialized across the RSC→client boundary, making it a silent footgun. Pass `onAssignment` to `<AdaptiveProvider>` instead.
- **JSDoc `context` example corrected** — the `@example` block showed `context={{ appId: 'my-app' }}` (an object), but the actual type is the string union `'landing' | 'ecommerce' | 'saas' | 'marketplace'`. Corrected to `context="landing"`.

---

## 0.8.2 — 2026-06-30

### Patch Changes

- Updated `@sentientui/core` dependency to `0.8.1`, which adds SSR error logging so API failures (bad key, origin mismatch, timeout) are visible in the server console instead of silently falling back to default variants.

## 0.8.1

### Patch Changes

- f72c201: Fix unresolvable `@sentientui/core` dependency in the published package. Versions 0.2.1–0.8.0 were published with `"@sentientui/core": "workspace:*"` because CI used `npm publish`, which does not rewrite the pnpm workspace protocol. CI now uses `pnpm publish`, so the dependency is published as a concrete version range that npm and yarn can install.

## 0.8.0 — 2026-06-14

### Breaking Changes

- **`loadAdaptiveAssignments` return type changed** — see `@sentientui/core@0.8.0`. Users calling this function directly must destructure the result:

  ```diff
  - const assignments = await loadAdaptiveAssignments(components, options);
  - <AdaptiveProvider initialAssignments={assignments} ...>
  + const { assignments, sessionId } = await loadAdaptiveAssignments(components, options);
  + <AdaptiveProvider initialAssignments={assignments} ssrSessionId={sessionId} ...>
  ```

- **`loadAdaptiveDecision` return type changed** — now includes `sessionId` alongside the existing `DecideResult` fields.

### Added

- **`ssrSessionId` prop on `<AdaptiveProvider>`** — threads the SSR-generated session ID into `init()` so the client adopts the same session on first visit. Eliminates the orphaned-session bug that caused events and goals to be attributed to a different session than the one used for variant assignment during SSR.

- **`AdaptiveRoot` now passes `ssrSessionId` automatically** — no prop change required for `AdaptiveRoot` users. The session ID resolved server-side (from cookie or generated fresh) flows to the client without any user-facing change.

- **`LoadAdaptiveAssignmentsResult` type** — exported type for the new return value: `{ assignments: ServerAssignments; sessionId: string }`.

- **`LoadAdaptiveDecisionResult` type** — exported type for the new `loadAdaptiveDecision` return value, which extends `DecideResult` with `sessionId: string`.

- **`appOrigin` derivation in production** — `AdaptiveRoot` now derives the origin from the incoming `host` request header when `appOrigin` is omitted in production, instead of falling back to `http://localhost:3001`. Development still defaults to localhost.

### Fixed

- **`ClickGoal.selector` now respected** — see `@sentientui/core@0.8.0`.

- **`AdaptiveText` managed text no longer stuck on default when `initialAssignments` is provided** — see `@sentientui/core@0.8.0`.

- **Dev override log no longer fires on every render** — see `@sentientui/core@0.8.0`.

### Patch Changes

- Updated dependencies
  - @sentientui/core@0.8.0

## 0.7.1 — 2026-06-14

### Added

- **`microSignalGoals` prop on `<Adaptive>`** — `Partial<Record<MicroSignalType, string | { name, weight?, stepIndex? }>>`. When a mapped passive micro-signal fires on the component, the SDK records a named goal via `client.goal()` in addition to the existing `micro_signal` event. Intended for wiring inferred goals from the dashboard (e.g. `microSignalGoals={{ rage_click: 'confused_by_hero' }}`).
- **`MicroSignalGoals`** and **`MicroSignalGoalConfig`** types exported from the package entry.

### Patch Changes

- Updated dependencies
  - @sentientui/core@0.7.1

## 0.7.0

### Minor Changes

- 5fb52a7: Default API endpoint moved to `https://api.sentient-ui.com` (previously `https://sentient-api.fly.dev`). The new domain terminates TLS on an anycast edge close to your users and decouples the SDK from the hosting provider. Non-breaking: the old hostname remains valid, and explicit `ingestUrl` / `baseUrl` overrides are unaffected.

### Patch Changes

- Updated dependencies [5fb52a7]
  - @sentientui/core@0.7.0

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

### Patch Changes

- Updated dependencies
  - @sentientui/core@0.6.0

### Added

- **`WeightedCompositeGoal` type** — `{ type: 'weighted_composite', steps: Array<{ goal: GoalConfig, name: string, weight: number }> }`. Each step fires independently as it completes with its own fractional reward. Bandit convergence on multi-step funnels is 3–5× faster than waiting for full completion.
- **`WeightedStep` type** — `{ goal: GoalConfig, name: string, weight: number }` — one step in a weighted composite goal.
- **Micro-signal detection wired into `<Adaptive>`** — every mounted `<Adaptive>` now passively attaches behavioral detectors (rage click, text copy, scroll hesitation, tab loss) via an internal `useEffect`. No prop changes required. Signals are emitted as `micro_signal` events and feed the auto-discovery system.

## 0.5.0

### Added

- **`agentDataByVariant` prop on `<Adaptive>`** — `Record<string, unknown>` keyed by variant ID. Only the assigned variant's entry is stored so AI agents receive the content currently being served, not a map of all options. Prefer this over `agentData` when variants have different content.
- **`agentData` deprecated** — still accepted for backward compatibility but the per-variant `agentDataByVariant` is the correct pattern going forward.

### Updated dependencies

- `@sentientui/core@0.5.0`

## 0.4.0

### Added

- **`agentData` prop on `<Adaptive>`** — optional `unknown` value passed through `useAssignment` to `client.assign()`. SentientUI stores the value alongside the assigned variant so the Agentic Content API can return it to AI agents.
- **`preConsentBehavior` prop on `<AdaptiveProvider>`** — threads through to `init()` so React apps can declare `'statistical_winner'` or `'control'` pre-consent behavior declaratively without calling `init()` directly.

### Updated dependencies

- `@sentientui/core@0.4.0`

## 0.3.2

### Patch Changes

- Add SSR timeout with fallback to prevent cold API from blocking page render

  `preloadAssignments` and `preloadDecisions` now abort after 1500 ms by default and return
  default variants rather than hanging the server indefinitely. The timeout is configurable
  via a new `timeoutMs` option on `ServerAssignConfig`, `loadAdaptiveAssignments`,
  `loadAdaptiveDecision`, and `<AdaptiveRoot>`.

- Updated dependencies
  - @sentientui/core@0.3.1

## 0.3.1 — 2026-05-30

### Fixed

- Restored `useAdaptiveProjectId` as a deprecated alias of `useAdaptiveApiKey`. The hook was renamed in 0.3.0 without an alias, which broke any external import. New code should use `useAdaptiveApiKey`; the old name will be removed in 0.4.0. Emits a one-time `console.warn` in development so the deprecation is visible.

## 0.3.0 — 2026-05-29

### Added

- **`<AdaptiveText>`** — text-content A/B component. Pass `id` and `default` text; the SDK fetches the winning content variant from the API and swaps it in after mount. Tracks `variant_assigned` impressions automatically.
- **`sections` prop on `<AdaptiveRoot>`** — when provided, `<AdaptiveRoot>` calls `POST /v1/decide` instead of `/v1/assign`, resolving layout order and variant assignments in a single server roundtrip. Cluster-based section reordering is applied before HTML is sent.
- **`useLayoutOrder()`** — client-side hook that returns the current `string[]` section order from context. Use in any client component that needs to mirror the SSR-resolved layout.
- **`loadAdaptiveDecision()`** — client-side counterpart to `preloadDecisions()`; fetches a fresh decision and seeds both the assignment cache and layout order context.
- **`initialLayoutOrder` context** — SSR-seeded layout order propagated from `<AdaptiveRoot>` through the React tree so `useLayoutOrder()` has the correct value on first paint.

### Updated dependencies

- `@sentientui/core@0.3.0`

## 0.2.1

### Patch Changes

- 7d31c76: Fix ingestUrl removal fallout: guard empty ingestUrl in core init(), resolve undefined ingestUrl in graph entry, remove stale ingestUrl/apiBaseUrl props from AdaptiveProvider and AdaptiveRoot call sites.
- Updated dependencies [7d31c76]
  - @sentientui/core@0.2.1

## 0.1.0 — 2026-05-18

### Added

- **`<Adaptive>`** — wraps any React node in a multi-armed bandit experiment. Tracks `variant_assigned` impressions and wires up goal events. Renders the SSR-preloaded variant on first paint with no hydration mismatch.
- **`<AdaptiveRoot>` (Next.js App Router)** — server component that preloads variant assignments before HTML is sent to the browser. Zero layout shift, crawlable markup.
- **`<AdaptiveProvider>`** — client-side provider for Vite, CRA, Remix, and Next.js Pages Router. Initialises the core SDK in a `useEffect`.
- **`useAssignment`** — returns `{ variantId, isLoading }` for programmatic branching without a wrapper element.
- **Goal types** — `click`, `scroll_depth`, `form_submit`, `composite`.
- **`clientOnly` prop** on `<Adaptive>` — renders nothing during SSR; avoids hydration mismatch for cookie-dependent slots.
- **`consent` prop** on `<AdaptiveProvider>` / `<AdaptiveRoot>` — gates the entire SDK. When `false`, no cookies are written and no events are sent.
- **`onAssignment` callback** — called once per component on first variant resolution. Use to forward assignments to Mixpanel, PostHog, Segment, etc.
- **Local dev overrides** — `?sentient_variant=componentId:variantId` URL param or `window.__sentient_overrides`; logs `console.info` when active.
- **HTML preview capture** — on `variant_assigned`, captures `innerHTML` (capped at 30 KB) and sends as `previewHtml` for the dashboard variant preview modal.

### Bundle size (gzip)

| Entry               | Size   | Limit   |
| ------------------- | ------ | ------- |
| `@sentientui/react` | 3.4 KB | 15.0 KB |
