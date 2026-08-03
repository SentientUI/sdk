# @sentientui/snippet

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
