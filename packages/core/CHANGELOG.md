# @sentientui/core

## 0.36.0

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

- fc6d2cd: SSR helpers (`preloadAssignments`, `preloadDecisions`) accept an optional `serverKey` (the project's secret key, server-only). When set, calls carry `X-Sentient-Server-Key`, and the API exempts them from the 100 requests/min per-IP cap meant for browsers — all SSR traffic from one server address used to share that cap whatever the plan. Nothing changes when it is unset; it is never sent when `window` exists.

### Patch Changes

- fc6d2cd: Slot registration (`reportSlots` / `requestSlots`) sends the page's session id alongside any baseline text. The API now stores a reported baseline text only when visitors from several networks, on sessions later scored human with real events, agree on it (or when the project owner confirms it in the dashboard). Without the session id a report is still recorded, but it can never be the vote that stores the text.
- Updated dependencies [ca64b25]
  - @sentientui/policy@0.12.1

## 0.35.0

### Minor Changes

- 6dcc0b9: Consent platforms built in. `consentFrom` now accepts `'cookiebot'`, `'onetrust'`, `'cookieyes'`, `'tcf'` (any IAB TCF v2.2 CMP) and `'google-consent-mode'` (any CMP that drives Consent Mode v2), or `{ cmp, category | group | purposes | type }`. The SDK reads each platform's own API and events — accept and withdraw — and Next.js `AdaptiveRoot` reads the platform's own consent cookie on the server, so returning consented visitors get server rendering. The snippet supports the same option (`window.sentient = { consentFrom: 'cookiebot' }`).

  Fixes: a server-resolved consent no longer overrides a mid-visit withdrawal; custom `consentFrom.event` is heard on `document` as well as `window` (CookieYes dispatches on `document`). The consent code lives on `@sentientui/core/consent` and React loads it only when `consentFrom` is set. Style capture now ignores floating widgets and consent banners.

## 0.34.3

### Patch Changes

- 0633527: - Next.js `AdaptiveRoot` now passes the site styles from the server decision to the page. Redesigned versions served through server rendering rendered with no site styling at all (plain palette buttons, unreadable text on dark sections).
  - Style capture picks the right buttons: buttons are ranked by their size on the page rather than by how often they repeat (a page's main call to action appears once), "main button" means a solid fill that stands out from what's behind it (not a subtle chip), and icon-only controls are no longer captured as buttons. Re-capture your site styles after upgrading.

## 0.34.2

### Patch Changes

- 14cfb6f: Redesigned versions keep the text colour of the site styles they borrow. A captured style whose class list doesn't set a text colour (the colour was inherited from the section around it) now records that, and both renderers apply the measured colour to the borrowing element — previously such a button could render with dark text on a dark fill when used somewhere else on the page. Re-capture your site styles (Settings → Site styles → Refresh from your site) after upgrading.

## 0.34.1

### Patch Changes

- e125fe4: Redesign works on components, not just sections, and on Tailwind v4 sites.

  - React: an `<Adaptive>` that wraps a component (`<Adaptive><CtaButtons /></Adaptive>`) was reported as unaddressable and could not be generated for at all. Its structure is now captured for redesigns (the whole region is replaced), while per-element rewording stays off because React can't see a component's inner text.
  - Style and region capture read modern CSS colours. Browsers report Tailwind v4 colours as `lab()`/`oklch()`, which capture couldn't read, so a site's filled primary button lost its fill and grey text lost its colour. They are now converted to `rgb` (in the editor-only bundles; nothing is added for visitors).

## 0.34.0

### Minor Changes

- b79562c: Redesigned sections render with your site's own styles. Generated sections (heroes, feature bands) now borrow the class lists your site already uses — its buttons, headings, text and section backgrounds — instead of approximating them with a color palette. New: `@sentientui/core/style-sample` (loaded only in dashboard-opened sessions), `getStyleVocabulary()`, heading level 1 in composition blocks (only where the region already holds the page's main heading), and `renderCompose` in `@sentientui/react`. Regions now report the page they live on, so a generated section can agree with the page around it.
- 46e7db2: Generated versions now edit the region you wrote, element by element: new button labels land inside your own buttons (classes, links, icons intact), with optional hide / reorder / emphasis swap. The SDKs report each region's structure so generation can see it, and tell the server what a page can render so no visitor is ever assigned a version their page can't show. Region capture ships as the new `@sentientui/core/region` entry.
- 0c6c86b: `<Adaptive>` now accepts `variants` and children together: your hand-written versions and dashboard-generated ones compete in one experiment, with your children as the original. A component that previously ran with `variants` only keeps working unchanged; moving it into a combined experiment is an explicit Migrate action in the dashboard, which archives its earlier results. Also fixes the consent-gated client dropping the page's render capabilities, which kept Rewrite versions from being served there.

## 0.33.0

### Minor Changes

- 4f8726d: Server-side AI-assistant capture for any framework, from `@sentientui/core/server`:

  - `captureAgentRequest(request, { apiKey, source?, waitUntil? })` logs a fetch whose user agent is a known AI assistant or crawler (ChatGPT-User, Claude-User, Perplexity-User, GPTBot, ClaudeBot, …). It works with a Fetch API `Request`, so it covers edge functions (Vercel Routing Middleware, Cloudflare Workers, Netlify Edge) in front of any site, plus Hono, Remix / React Router, Astro and SvelteKit. On edge runtimes pass the platform's `waitUntil`, or the request is dropped when the response returns.
  - `sentientAgentMiddleware({ apiKey })` does the same for Express, Nuxt/Nitro on Node and any `(req, res, next)` stack.

  Only the path (never the query string) and the user agent are sent. Requests from people make no network call. Capture only observes: nothing about the response changes. The integration guide (`get_integration_guide`) gains a "Capture AI assistants" section.

## 0.32.0

### Minor Changes

- 79372a8: Engagement capture now reports session-scoped interaction aggregates (counts, means and variances of pointer, scroll, keystroke and action-timing behaviour) as one `interaction_stats` event per bank point, under the existing DNT/consent gate. Every visit reports, however short. Read by the hosted bot scorer to separate browser-driving agents from people; never used to change what is served. No raw events, coordinates or text leave the page.

  Adds `SentientClient.flush()`, and the engagement capture calls it after banking on every leave path. The event queue installs its own `pagehide`/`visibilitychange` flush when the client is created — before the capture module is imported — so dwell and interaction events banked inside those same handlers were enqueued after the queue had already drained, and a visit shorter than the 5 s queue tick delivered nothing at all. Call `flush()` yourself if you track anything from your own unload handler.

## 0.31.1

### Patch Changes

- Updated dependencies
  - @sentientui/policy@0.12.0

## 0.31.0

### Minor Changes

- f304caf: An exposure or a conversion is only recorded for an arm the server actually
  decided this session.

  The core seeds a slot's result from two places that are not decisions: the
  pre-paint snapshot on a return visit, and the baseline it falls back to when a
  `decide` call fails. Both render — that is the point, the visitor sees content
  immediately — but neither has a `slot_decisions` row behind it, so counting them
  produced impressions for arms that were never served and conversions with no
  trial to credit.

  - `SentientClient.isSlotDecided(slotId)` reports whether a slot's current result
    came from a server decision (or an SSR seed) as opposed to a snapshot or a
    failure baseline.
  - `componentGoal()` and `track({ eventType: 'variant_assigned' })` now refuse to
    attribute to an undecided slot arm, so a hand-rolled integration cannot record
    one either. Variant components (which resolve from the assignment cache) and
    SSR-preloaded slots are unaffected.
  - `SentientClient.cancelSlots(slotIds)` withdraws a pending ask. React hooks call
    it on unmount, so a region that mounts and unmounts inside one batching tick no
    longer takes a trial it will never show.
  - A failed `requestSlots`/`decideSlots` batch is now retried with bounded backoff
    (2 attempts) instead of leaving the region on its baseline for the rest of the
    session with nothing recorded.

  `@sentientui/react`: `useSlotResult` and `useSlotConfig` resolutions gained a
  `'seeded'` source for exactly this state. `<Adaptive>`, `<AdaptiveGroup>` and
  `useAdaptiveTokens` render it and skip the exposure and goal wiring.

- f304caf: One `<Adaptive>` instead of two components. `<Adaptive id>` now covers both
  shapes: wrap the markup you already ship and versions of it are generated and
  published from the dashboard (`AdaptiveGeneratedProps`), or pass `variants` and
  write the alternatives yourself (`AdaptiveVariantsProps`). Children or
  `variants`, never both.

  `<AdaptiveSlot>` is deprecated, not removed — it still renders, and its logic is
  now the same code path as `<Adaptive>`. Migrate by renaming the element;
  `onFormSubmit`, `reportBaselineText` and `clientOnly` mean what they did.

  The `context` prop/config field is deprecated and ignored everywhere it appears
  (`AdaptiveProvider`, `SentientConfig`, `window.sentient`) — the project's type is
  set in the dashboard. It is still accepted, and now optional; `@sentientui/cli`
  no longer prints it. Safe to omit.

  **Breaking (types) for `AdaptiveRoot`:** its `consentFrom` no longer accepts a
  `check` callback. `AdaptiveRootProps` used to inherit `consentFrom` wholesale
  from `AdaptiveProviderProps`, so a JS-API CMP predicate type-checked there while
  being unusable — `AdaptiveRoot` runs on the server, where a client callback
  cannot be evaluated, so SSR silently treated those visitors as un-consented.
  Cookie-based `consentFrom` is unchanged. For a JS-API CMP, put
  `<AdaptiveProvider consentFrom={{ check }}>` in a client component instead.

  Mounted regions decide client-side in one batched call
  (`requestSlots`/`decideSlots`/`onSlotsChanged` on `SentientClient`), so a
  client-rendered app no longer needs an SSR preload to get a decision — it
  previously showed its baseline for the whole session. First paint shows the
  original briefly, then swaps; return visits start from the last served version.

  **Decisions are page-scoped.** A slot only decides, and only records a trial,
  when it is on the page the visitor is looking at. Previously a mounted region
  could take a trial it could never convert, which biased every arm that happened
  to be declared on more pages than it rendered on. `@sentientui/core` exports the
  matcher behind this (`pageScopeMatches`, `PAGE_SCOPE_RE`) so a target's page
  scope can be evaluated the same way client- and server-side.

- 036af5e: The four seeded personas are gone from the SDK surface. Projects have started with an empty persona vocabulary since 2026-09-13; this removes the last code that still named them.

  **Breaking for anyone importing these from `@sentientui/policy`:** `PERSONAS`, the `Persona` and `PersonaKey` types, `PERSONA_DISPLAY`, `LEGACY_PERSONA_MAP` and the deprecated `CLUSTER_PRIORITY` are removed. Use the project's own vocabulary for persona keys and display names (`UNKNOWN_PERSONA_DISPLAY` covers `'unknown'`), and `LAYOUT_ARCHETYPES` / `orderByArchetype` for orderings.

  `canonicalPersona` no longer looks labels up in a table of those four names: it trims, lowercases and returns any key-shaped label (`PERSONA_KEY_RE`), and `'unknown'` otherwise. Previously every other label — including every key a customer declared — came back `'unknown'`. It still says nothing about vocabulary membership; `resolvePersona` checks that. `decisionPersona` and `resolvePersona` no longer remap the old plural labels (`'buyers'` → `'buyer'`), and `RESERVED_PERSONA_KEYS` is now just `['unknown', '__all__']`.

  `@sentientui/core`: keyless local mode with no forced persona now resolves `unknown` (the authored order and baselines) instead of hashing the session onto one of the four names. `?sentient_persona=<key>` still previews any key.

  `@sentientui/react`: devtools no longer offers the four names as persona buttons when the project vocabulary is unavailable; it lists the vocabulary it fetched, plus `unknown` and a free-text key.

- f304caf: **Breaking for SSR registry preloads:** `preloadDecisions` (`@sentientui/core/server`)
  and `loadAdaptiveDecision` (`@sentientui/react/server`) now require
  `registrySlotIds` when called with `slotsFrom: 'registry'` — the list of
  `<Adaptive id>`s that the page being rendered actually contains.

  Without it the preload asked the server to decide every published slot in the
  project, on every page, and each of those decisions was recorded as a trial. A
  slot that never rendered could therefore accumulate exposures it had no chance
  of converting, which pulls its posterior toward zero and makes the arm look
  worse than it is.

  A call that omits `registrySlotIds` no longer throws or silently proceeds: it
  logs an error naming the problem and falls back to request mode, so pages keep
  rendering while the phantom trials stop. Pass the ids to restore registry
  behaviour:

  ```tsx
  await loadAdaptiveDecision({
    slotsFrom: 'registry',
    registrySlotIds: ['hero-cta', 'pricing-table'],
  });
  ```

### Patch Changes

- Updated dependencies [036af5e]
  - @sentientui/policy@0.11.0

## 0.30.0

### Minor Changes

- 68151cd: Sections need one attribute of markup: `data-sentient-id`. Declare what a section is with the new `sectionTypes` prop on `AdaptiveRoot` / `AdaptiveProvider` (`sectionTypes={{ about: 'trust', contact: 'cta' }}`) instead of a per-element `data-sentient-type`. Only the sections the content classifier gets wrong need declaring, and a section doesn't have to be in `sections` to be typed. The map reaches both the graph scanner (`createDOMScanner({ sectionTypes })`, `init({ graph: true, sectionTypes })` from `@sentientui/core/graph`) and engagement capture, and it wins over `data-sentient-type`, which is still honoured for existing markup and the no-code snippet. `SemanticType` is now exported from `@sentientui/react`.

## 0.29.1

### Patch Changes

- 316f827: Layout candidates no longer depend on what a persona is named, and the authored order is always an arm.

  `candidateLayouts` dropped its `persona` parameter and now always includes the page's own order. The set of orderings a page could be shown in is a property of the page; the persona belongs in the posteriors, which is where the caller already had it. Previously the authored order only made the candidate set when the requesting persona's name happened to miss the archetype table — so a project that declared `buyer` had its own layout excluded entirely, leaving the bandit no way to conclude "leave this page alone" and nothing for a holdout to compare against.

  `CLUSTER_PRIORITY` is deprecated in favour of `LAYOUT_ARCHETYPES`, whose keys (`conversion_led`, `evidence_led`, `price_led`, `discovery_led`) name what an ordering does rather than who it is for. The arrays are unchanged and `hashLayout` hashes the resulting order, so every stored `layout_weights` row still joins.

  `applyClusterHeuristic` is deprecated. Server code should use `orderByArchetype` (by archetype); the keyless local engine uses the new `previewOrderForPersona`, which maps ANY key onto an archetype — previously only the four seeded persona strings did anything and every other key silently no-oped, including the ones the CLI and docs told people to try.

- Updated dependencies [316f827]
  - @sentientui/policy@0.10.0

## 0.29.0

### Minor Changes

- a3ce1dd: Adaptive changes now announce themselves with a brief, deliberate motion.

  When a slot's content changes after the page has painted — a first-visit decide
  resolving, or a return visitor's persona upgrade re-deciding — the region
  animates from 55% opacity to full over 240ms instead of snapping. Three rules
  make it safe to ship on someone else's site:

  - **It is never a cloak.** Nothing is hidden and then revealed. The element is
    legible at every frame, so a visitor arriving mid-animation reads real
    content and a script that fails halfway leaves a page that was never hidden.
  - **It only fires on a real, post-paint change.** A return visitor's arm is
    applied by the pre-paint tag and an SSR slot arrives with its arm already in
    the HTML — the page was always that way, so animating it would be theatre on
    every page load. The snippet compares the text it is replacing; React tracks
    the arm across renders.
  - **`prefers-reduced-motion` wins unconditionally.** Not a config option: the
    keyframes are defined only inside a `no-preference` query, so a browser that
    mis-reports it applies no transform at all. The content still changes,
    instantly.

  The served arm and persona are written as `data-sentient-arm` /
  `data-sentient-persona` for devtools and the editor. Nothing is rendered to a
  visitor — telling your visitors they are being personalized is your decision
  about your site, not a default we ship.

## 0.28.0

### Minor Changes

- c9c1260: Fully-design ladder rung 1: composition blocks can now be cards. Stacks accept
  `surface: 'raised'` (site-palette surface background + border hairline + radius
  - a contrast-derived `surfaceText` pairing; defaults to `md` padding), stacks
    and grids accept `pad` (reusing the gap scale), a `divider` block draws a
    hairline in the palette border color, and `maxWidth: 'measure'` caps text and
    heading copy at a readable 65ch. All token-resolved — no color or pixel props —
    rendered identically by the snippet and React renderers, total-validated
    server-side, and drift-pinned so the three parties cannot disagree silently.

## 0.27.0

### Minor Changes

- 3188a9d: Form block type + client slotConfig/palette getters

  - New `form` composition block (`FormBlock`/`FormField`, `containsFormBlock`) — fields are a validated prop array (`input`/`textarea`/`select` kinds), never free-floating blocks, so an input can never appear outside a form
  - `SentientClient.getSlotConfig(slotId)` and `getSitePalette()` expose registry slot config to SDK surfaces (previously snippet-only); seeded from the snapshot, `initialSlotConfig`/`initialPalette` config, and decide responses; the snapshot now accumulates slotConfig across decides like slot results
  - SSR `preloadDecisions` accepts `slotsFrom: 'registry'`, unions undeclared registry slots into the result, and returns `slotConfig`/`palette`
  - `SentientClient.reportSlots(slotIds)` — fire-and-forget, batched, deduped reporting of mounted AdaptiveSlot ids so unseen slots auto-register server-side as drafts

## 0.26.0

### Minor Changes

- 4edb1ec: Report which SDK a site is running, so the dashboard can flag an outdated install.

  `init()` accepts an optional `sdk: { name, version }`, forwarded on the session
  upsert as `sdk` / `sdkVersion`. Both wrappers set it from their own build-time
  version: `@sentientui/react` via a new tsup `define` (mirroring the snippet's
  `__SNIPPET_VERSION__`), and `@sentientui/snippet` alongside the build version it
  already reports on decide.

  The session upsert is the carrier because it is the one call every integration
  makes — decide covers only the slot paths, which is why React installs were
  previously invisible. Additive and best-effort: a dev-sentinel version is never
  reported, an older API ignores the fields, and application code never sets this
  itself (core is a dependency of both wrappers, so its own version says nothing
  about what the customer installed).

  The snippet's install tag is now unpinned by default (`@sentientui/snippet/dist/
snippet.global.js`), so a pasted integration follows releases on its own —
  matching what the Shopify theme embed has always loaded. Pinning stays supported
  and is the only way to use Subresource Integrity.

## 0.25.0

### Minor Changes

- ada7994: Semantic-understanding batch (remaining-work items 2/3/5, 2026-09-05):

  - **Per-element section ids** — engagement capture now names each section
    `nc-<type>-<hash>` (a short locator-identity hash) instead of the collapsed
    `nc-<type>`, so two same-typed bands stop sharing one dwell row and
    "which features band holds attention?" becomes answerable. Elements with no
    resolvable locator keep the collapsed id. Type-level rollups are unaffected;
    pre-change dwell history stays on the collapsed ids and ages out of the
    reporting windows.
  - **Client-sensor observations** — every section-map entry now carries the
    section's structural features (tag, id/class, heading, text length, action
    count, ARIA role) plus booleans for which shipped CONTENT_PATTERNS matched
    the body text. The body text itself never leaves the page. This is the only
    classification channel for pages the crawler cannot fetch (CSR, auth-walled),
    which previously got no topic/role enrichment at all.
  - **`data-sentient-id` joined `STABLE_DATA_ATTRS`** (both locator generators
    together, per the original deferral note): the attribute a site authors to
    name a section for us now wins its locator, ahead of `data-testid`. Elements
    with a unique `id` are unaffected; for the rest the section key moves once
    and ingest-time fingerprint reconciliation records the alias.
  - Snippet always-on budget re-baselined 22→23 KiB for the above (measured
    22721; the accounting trail lives in `scripts/size-check.ts`).
  - **Nav-wrapping headers stop classifying as heroes** — a `<header>` with 5+
    actions is the site's navigation (measured on the hold-out corpus: real nav
    headers carry 10–114 links, authored heroes 0–2). Shared rule, so browser
    and crawler agree; hold-out accuracy moved 0.598 → 0.670 with the golden
    corpus holding at 1.00.
  - **`CLASSIFIER_VERSION` exported from `@sentientui/core/topics`** — anchors
    the server's shadow-label rollout: bump it when classification behaviour
    changes so live projects keep serving their promoted labels until an
    operator reviews the diff and promotes (with one-click rollback).

### Patch Changes

- Updated dependencies [ada7994]
- Updated dependencies [ada7994]
  - @sentientui/policy@0.9.0

## 0.24.0

### Minor Changes

- d5d49a1: Capture ad-platform click IDs (gclid, gbraid, wbraid, fbclid, ttclid, msclkid, twclid, li_fat_id) from the landing URL alongside `utm_*` params, on a new `clickIds` field of the session upsert. Google Ads auto-tagging appends only `gclid` — no `utm_*` at all — so paid Google/YouTube traffic without manual UTM templates previously reported as organic. New `extractTrackedParams()` and `CLICK_ID_KEYS` exports (browser and server entries) split a query string into `{ utmParams, clickIds }`; `ServerAssignConfig` and `buildSessionUpsertPayload` accept `clickIds` so SSR preloads can carry attribution too. Click IDs are used for paid-vs-organic analytics only — never to decide what a visitor is shown.

## 0.23.0

### Minor Changes

- af5b76c: Semantic section identity + topic-aware classifier (semantic-graph phases 1–2c).

  - New `@sentientui/core/topics` entry (server-only by design — do not import it
    from browser bundles): the ~40-topic vocabulary, `classifyTopic` returning
    `{topic, parent, role, strength, stage}`, schema.org `@type` → topic mapping.
  - Classifier rewrite in `engagement/classify.ts`, each fix reproduced against
    the shipped classifier first: structural rules run before the converter
    fallback (a `<div class="navbar">` no longer classifies `cta`), `<header>` is
    a hero by HTML-AAM mapping, ARIA landmark roles are honoured, and the
    over-broad `plans?`/`customers?` keywords are tightened. New content-evidence
    patterns classify body text when headings give nothing.
  - `locatorFromElement` (new `locator-from-dom.ts`): live-DOM twin of the
    server's locator generator — id → stable data-attr → shortest unique
    selector, always fingerprinted, refusing ambiguous identities. Parity with
    the server implementation is CI-locked.
  - The DOM scanner and engagement capture now attach compound locators, and
    capture registers one section-map entry PER ELEMENT (with per-element
    provenance) instead of one per collapsed `nc-<type>` component, so the server
    can derive a distinct `section_key` per physical section.

  Serving behavior is unchanged by this release — the identity and topic layers
  are data collection until the server's phase 2d ships.

### Patch Changes

- Updated dependencies [af5b76c]
  - @sentientui/policy@0.8.0

## 0.22.0

### Minor Changes

- c69cdaf: September audit fixes. Breaking for unlikely consumers: the dead `GraphClient.serialize()`/`restore()` methods and `AssignmentCache.invalidate()` are removed, and the `/graph` entry's zero-network gate now also covers `localMode: true` and invalid (non-`pk_`) keys, matching the lean `init`.

  Fixes: `destroy()` (forget-me) now clears the localStorage assignment cache and tombstones the legacy bare `_snt_uid` so a revoked visitor is not re-personalized or re-identified on the next init; the graph scanner observes inserted subtrees (SPA-mounted components are no longer invisible) and dynamic `<aside>` elements; `decide()` no longer overwrites previously served slot results with synthesized baselines when a response omits a slot; `decide()` and the pre-consent winner path gained in-flight coalescing (N concurrent identical calls share one roundtrip); `grantConsent()` resolves gated keyless/invalid-key clients instead of warning "called before init()", warns instead of silently no-oping when an upgrade is impossible, and `/graph`-entry clients now mount the scanner after consent; the in-memory event queue is bounded (drop-oldest) during sustained outages; local-mode `getPersona()` honors `initialPersona` and the snapshot before the first decide. The `/graph` entry re-exports the full lean surface (`grantConsent`, snapshot/pre-paint helpers, slot helpers, blocks, micro-signals, cookie names), and `deriveSessionSegment` backs the React provider's segment derivation.

### Patch Changes

- Updated dependencies [c69cdaf]
  - @sentientui/policy@0.7.0

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
