# @sentientui/cli

## 0.4.0

### Minor Changes

- 2cc598a: Consent fixes and hardening from the 2026-09-24 SDK audit.

  **Consent**
  - `consentFrom: 'google-consent-mode'` now reads region-scoped defaults (`gtag('consent', 'default', { …, region: ['ES'] })`). Before, a region-scoped denial with a global grant read as granted everywhere, EU visitors included. Pass `region` (e.g. from your CDN's country header) to resolve them exactly. Without it, a region-scoped denial reads as denied until an `update`.
  - New `consentFrom: 'shopify'` preset (Shopify Customer Privacy API). On a Shopify storefront the snippet uses it automatically when neither `consent` nor `consentFrom` is set, because Shopify's own banner and every Shopify cookie-banner app report into it.
  - **Behavior change:** `consentFrom: 'tcf'` now requires purposes 1, 5, 6 and 8 (storage, content profiling, personalised content, content measurement; 8 may rest on legitimate interest) instead of purpose 1 alone, and takes an optional `vendorId`. Sites whose CMP grants only purpose 1 stay gated. Only a refusal of purpose 1 (storage) deletes the visitor's data. Missing profiling purposes only gate, because many CMPs never offer them. Under `purposeOneTreatment` the TC string carries no storage answer, so no TCF signal deletes there: a refusal only gates.
  - React: withdrawing consent with `preConsentBehavior="statistical_winner"` now forgets the visitor (cookie, assignment cache, decision snapshot), as it already did without it. Engagement capture no longer starts, or POSTs `/v1/section-map`, for a visitor who hasn't consented.
  - A refusal recorded by a consent source (`consentFrom`) forgets the visitor even when it was given before this page loaded, and `revokeConsent()` / `client.destroy()` forget even when no tracking client ever started (a "Reject" on a manual gate). `consent: false` on its own is a gate, not a refusal, and deletes nothing. Before, only a revocation during a page view with a live tracking client deleted anything, so a "no" given on a CMP settings page or at checkout left the 365-day ID and the decision snapshot in place. Watchers gain `refused()`, which is true only for a recorded "no": a Cookiebot, OneTrust or CookieYes answer, a Shopify `'no'`, a TCF decision that refuses purpose 1 (storage), or a Consent Mode `update` (never a `default`). A platform that is still loading, showing its banner, or reopened by a consented visitor only pauses tracking and keeps the visitor's identity. `forgetVisitor(apiKey)` is exported from `@sentientui/core/consent`.
  - `client.destroy()` no longer re-creates the retry bucket when its final delivery fails.
  - Session-level conversions (`goal()`) recorded while consent is pending (in memory only, capped at 100) are sent if consent is granted in the same page view. They are dropped on refusal, dispose, or under DNT/GPC. A consented visitor's goal fired before the consent platform answered used to be lost. This covers the snippet and core's `grantConsent()`, and in React a provider with `preConsentBehavior`. Without `preConsentBehavior`, React has no client before consent, so fire conversions once `useSentient()` returns one, or use `usePageGoal`, which waits for the tracking client. Component goals and exposures from before consent are not recorded: the visitor saw the baseline, and replaying them would credit a variant they never saw. Gated clients expose `gated: true`.
  - A `decide()` asked while consent is pending is held and sent once consent is granted, so a consented visitor whose consent platform answers after the page starts is still personalized on that page. It is dropped if the visitor has moved to another path.
  - **Snippet: a consent config it can't use fails closed.** An unknown `consentFrom` or a non-boolean `consent` now keeps tracking off and logs a warning. Before, it was ignored, so every visitor was tracked.
  - TCF consent recorded in the publisher segment counts too, both in the browser and on the server (`AdaptiveRoot`).
  - Custom `{ check }` sources take an optional `refused: () => boolean`. Without it they only pause on false.
  - The decision snapshot is ignored after 30 days, as documented. A decide still in flight when the visitor is forgotten no longer writes the snapshot or assignment cache back. After a failed first decide, the snippet decides again on the next SPA navigation. Hash-router navigations count as page changes for the held decide.
  - `SentientPersonaScript`'s snapshot fallback skips DNT/GPC browsers and snapshots older than 30 days. It renders nothing when given `consent={false}`, or `consentFrom` without `consent={true}`, unless it was passed a server-decided `persona`, which reads no storage.
  - A forget-me can't be undone within the page. Every client and queue remembers the project's forget generation and never writes after it changes, even when a later grant creates a new client. A decide or assign still waiting for the session isn't sent once the client is torn down.
  - Held conversions are replayed one per task, so two identical held clicks stay two conversions. React drops held conversions when the consent source records a refusal. A gated client that was refused (or disposed) holds nothing more, so goals fired after a "no" are never sent on a later accept, and it answers `decide()` with `null` without sending (`client.released`). A disposed or forgotten client sends nothing more: no goals, identify, events or session retries.
  - The OneTrust cookie parser reads only the real `groups` field. An encoded `groups=…` inside `landingPath` (the landing URL, before any answer) used to read as consent, in the browser and in `AdaptiveRoot`, which now reads the raw `Cookie` header because Next's `cookies()` decodes values.
  - A consent-gated client that was disposed or destroyed before consent arrived is no longer upgraded by a later `grantConsent()` (it warns instead); call `init()` again. In React a recorded refusal releases the gated client, so goals fired after it are dropped. In React, once a consent source has answered in the page load (across provider remounts), a later "no answer" (for example a banner reset that deletes its cookie) pauses tracking instead of falling back to `AdaptiveRoot`'s server-side read. The snippet pauses the same way. Held goals replay in order, ahead of goals fired after the grant. A goal that reaches a paused client's queue while its first session upsert was still in flight is kept for retry on the next page instead of being dropped. A TCF loading callback after a decision no longer resets it to unknown. A second embed of the snippet restores the live `SentientSnippet` API instead of replacing it. The snippet's pre-boot stub can queue `grantConsent` and `revokeConsent` as well as `goal`.
  - TCF: a loading callback reads as unknown instead of refused, and under `purposeOneTreatment` purpose 1 is not required.
  - `renderPrePaintScript` is public API. Render it only once consent is known (see the core README).
  - The dashboard's no-code install page asks which cookie banner the site uses and writes it into the snippet (`consentFrom`, or `consent: false` for the site's own banner). Choosing "no banner" shows a warning.
  - **Rollout order:** release these packages to npm before the Shopify theme-embed update. The embed loads the latest snippet, and a snippet older than this release ignores `consentFrom: "shopify"`.
  - Nothing reads the stored decision snapshot before consent. The snippet's own pass and the inline pre-paint script skip it for `consentFrom` and `consent: false` installs until consent is known (the Shopify theme embed declares `consentFrom: "shopify"` from its next release). A DNT/GPC client's `decide()` resolves `null` at once. A `decide()` asked while consent is pending resolves once it is granted, or `null` on `dispose()`.
  - The snippet's engagement capture is a lazy chunk (`engagement.global.js`), fetched at boot in parallel with the decide. The always-on bundle drops from about 32 KB to about 28 KB gzip (28,670 bytes as measured by `size-check`, which enforces a 29 KiB ceiling).
  - The identity cookie is `SameSite=Lax` instead of `Strict`, so a server-side render sees a returning visitor who arrives from another site.
  - The snippet's editor bundle no longer overwrites the `SentientSnippet` page API when it loads. Preview and editor sessions no longer read the consent platform. A malformed `?sentient_preview=` falls through to an ordinary visit. Lazy chunks load from the snippet's own URL even when another vendor's `snippet.js` is on the page.
  - React warns once in development when neither `consent` nor `consentFrom` is set. `npx @sentientui/cli init --consent <preset>` writes the gate into the printed snippet.
  - The snippet loads the consent presets as a separate `consent.global.js` chunk, only on pages that configure a consent source, and the `?sentient_preview=` / `?sentient_persona=` QA modes as `preview.global.js`. Every other page's always-on bundle is smaller. **Behavior change:** `SentientSnippet.consentWatcher(source).read()` returns `null` until the presets chunk has loaded, so subscribe to it rather than reading once at load. A chunk URL that can't be derived (an inlined or renamed snippet) keeps tracking off and warns; set `consentSrc`. Self-hosted installs need the chunk files beside `snippet.global.js`.

  **Hardening**
  - Browser requests time out: 5 s for the read-only calls (winner, weights) and the session upsert, 15 s for queue deliveries. Decide and assign wait at most 2.5 s for the session; after that they aren't sent at all, so no decision or exposure is recorded for a page that won't show it. A decide or assign that has been sent is never cut short for being slow, because the server has already recorded it. Its answer is applied late, and only a dead connection is released, after 30 s.
  - Block `href`/`src` values are scheme-checked before rendering: https or a site path only, with no whitespace or control characters.
  - CSP nonce for injected `<style>`/`<script>`: `nonce` on `init`, `<AdaptiveProvider>`, `<AdaptiveRoot>` (already forwarded) and `window.sentient`. By default the SDK uses a page script's nonce.
  - The identity cookie is `Secure` on https pages.
  - A version-pinned snippet loads its lazy chunks (consent presets, editor) with Subresource Integrity.
  - The DOM scanner handles a burst of DOM changes in one pass, 200 ms after the burst starts, instead of on every mutation.

  **API**
  - `<Adaptive as="li" className="…">`: the wrapper element and class are configurable (both modes).
  - `useSessionSegment()` is exported from `@sentientui/react`.
  - Peer ranges are capped at the majors we test: `react >=18 <20` (the suite runs on 18 and 19), `next >=14 <17`. Packages declare `engines.node >=18.18`.

## 0.3.2

### Patch Changes

- f304caf: The scaffold and the integration guide now teach the shape that actually works.

  `@sentientui/cli`:

  - `init` scaffolds an `<Adaptive id>` hero instead of a `useAdaptiveTokens` one.
    A tokens slot only decides when it is also declared in `slots` on the root, and
    the wrap snippet the CLI printed never declared it — so with a real API key the
    scaffolded example looked live while serving its baseline forever. A generated
    `<Adaptive>` needs no declaration: the id registers the region on first mount.
  - The Next.js App Router snippet wraps with `AdaptiveRoot` from
    `@sentientui/react/next` rather than `AdaptiveProvider`. A root layout is a
    Server Component, and only `AdaptiveRoot` resolves the decision server-side and
    emits the pre-paint persona script; the provider meant no SSR assignment (a
    flash of the baseline on first paint) and no persona attributes at all.
  - The deprecated `context` prop is gone from every printed snippet.

  `@sentientui/mcp`: the integration guide documents generated versions as the
  starting point for Rung 2, the children-or-`variants` rule, the two-tag snippet
  install with the CSP-safe split form, and drops the `<AdaptiveSlot>` framing.

## 0.3.1

### Patch Changes

- 2f5d3ac: `init --key` can no longer claim a write it never made, and argument typos fail
  loudly instead of silently changing what init does.

  **The log said written; the file said local mode.** On an already-initialized
  repo, `writeEnvFile` returned 'kept' for any existing assignment — including
  the empty one a keyless `init` leaves — while init printed
  `.env.local kept: VAR=pk_live_…` as though the key had been written. The
  natural onboarding order (try local mode, then `init --key pk_…` with the real
  key) therefore left the app silently keyless. An explicitly passed --key now
  expresses intent: it overwrites a differing active assignment in place
  ('updated'), returns 'kept' only when the value already matches, and the log
  states what actually happened in every case. Without --key the
  never-clobber behaviour is unchanged, and an explicit empty `--key=` never
  blanks a configured key.

  **parseArgs hazards.** `--key` swallowed whatever token came next, so
  `init --key --yes` tried to use "--yes" as the API key; and unknown flags were
  silently ignored, so `init --kye pk_x` ran a keyless init while the user
  believed their key was configured. Option-shaped or missing --key values and
  unrecognized flags now exit 1 with the usage text before anything runs.

## 0.3.0

### Minor Changes

- e8c893d: `--help` and `--version` are real flags.

  `--help` landed in the command slot, so `npx @sentientui/cli --help` — the first
  thing a developer or an agent types — was treated as an unknown command and
  exited 1 with a one-line usage string. Both flags are now recognised in either
  position, print to stdout, and exit 0; the usage text documents `init`, every
  flag, keyless local mode, and where the docs live. An unknown command still goes
  to stderr and exits 1, which is the case that should have been failing all along.

## 0.2.6

### Patch Changes

- 8ecd00f: Point `repository` metadata at the public source mirror (`github.com/SentientUI/sdk`)
  so the "Repository" link on npm resolves, and add a `bugs` URL for issue reporting.
  No runtime changes.

## 0.2.5

### Patch Changes

- 0da8854: Audit-fix hardening across the CLI, MCP, and policy packages.

  **@sentientui/cli**

  - `init` now ABORTS (throws, non-zero exit) instead of merely warning when
    `--key` is not a publishable `pk_` key, so a secret `sk_…` can no longer be
    written into a client-exposed env var (`NEXT_PUBLIC_/VITE_/REACT_APP_`) and
    shipped to the browser. New `assertPublishableKey` guard.
  - `writeEnvFile`'s "already assigned" detection now also matches commented-out
    assignments (`# VAR=`), so it no longer appends a confusing active duplicate.
  - Build: `tsup` now targets `es2022` (the repo-wide `es2017` down-levelled
    `import.meta` to `{}`, leaving `import.meta.url` undefined so the bin's
    self-exec guard never fired) and runs with `shims:false` so `import.meta`
    stays native — matching the MCP boot-crash fix.

  **@sentientui/mcp**

  - `create_project` now routes through the shared `withApiErrorGuidance`
    wrapper (extended to accept per-tool extra/override case mappings) instead of
    re-implementing the `insufficient_scope` / `demo_read_only` / `insufficient_role`
    mapper with divergent wording — one guidance source.
  - `create_variant` output schema `displayName` is now `.nullable()` to match the
    API contract (`displayName ?? null`), and its `componentId` / `displayName`
    inputs now require non-empty strings with sane maxes.

  **@sentientui/policy**

  - `applyClusterHeuristic` maps a present-but-off-vocabulary section type (e.g.
    `newsletter`) to `generic`'s rank (last) instead of `indexOf === -1`, which
    had sorted it ahead of `pricing` and hijacked the top of every persona layout.
  - `validateSlotDecl` rejects `=` in enumerated arm ids (reserved for the dims
    encoding), keeping `parseArm(arm) !== null` a sound dims-vs-enumerated
    discriminator.
  - `weightCellsFor` treats an empty-string persona like `unknown` (segment
    marginal + global only), defensively avoiding a stray `''` child weight row.

## 0.2.4

### Patch Changes

- 150cd26: Warn loudly when a non-publishable key (e.g. a secret `sk_` key) is passed to the CLI, since it would be written into a client-exposed env var and shipped to the browser. Also makes the CLI entrypoint importable without side effects for testing.

## 0.2.3

### Patch Changes

- 7f3d9c6: Add `homepage`, `repository`, and `keywords` to package metadata so the packages are discoverable from the SentientUI brand on the npm registry and link back to the docs and source.

## 0.2.2

### Patch Changes

- 73f7c59: Add a README (what `init` does and does not do, `--key` flag) and reword the package description — `init` sets up adaptive UI but never edits your layout; you do the wrap-and-mount step it prints.

## 0.2.1

### Patch Changes

- Docs: correct the install command from `npx sentientui init` to `npx @sentientui/cli init`. The published package is scoped, so the bare `sentientui` name 404s on npm. Updates the CLI usage/help text and package description, the MCP integration guide, and the `llms.txt` agent-facing docs.

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
