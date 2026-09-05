# @sentientui/policy

## 0.9.0

### Minor Changes

- ada7994: Factored layout value model (spec 2026-09-04 §3a): `chooseLayoutFactored`,
  `layoutBucketOf`, `factorCellsForOrder`, `LAYOUT_FACTOR_BUCKETS` and
  `GLOBAL_FACTOR_PERSONA`. Scores candidate orders as sums of
  (parent semantic type × position bucket) cell draws — 40 global parameters plus
  EB-shrunk persona deviations instead of one independent posterior per
  permutation, so every trial teaches every candidate that shares its structure.
  Persona cells shrink toward the global cell and global cells toward the
  all-cells pool (mean-only crossing, per the pooling contract); one Beta draw
  per cell is shared across candidates so they compare under the same sampled
  world. Pure functions, tree-shaken out of every client bundle; the server
  serves it only behind a per-project flag that ships dark.
- ada7994: Phase 2d ordering projection: `applyClusterHeuristic`, `candidateLayouts` and
  `chooseLayout` accept an optional `sectionRoles` map. Structural sections
  (nav/footer/breadcrumb) are pinned at their original index and only
  converters/persuaders re-rank by the persona's parent priority — without the
  pin, 'navigation' ranks near last in every priority list, so a reorder would
  visibly drop the navbar to the bottom of the page. Callers that omit the map
  (the client-local fallback) get the previous behaviour byte-for-byte; the
  server passes roles from the unified `page_semantics`/`graph_nodes` read.
  Candidate layout hashes change for pages where pinning or enriched labels
  alter an order, so affected `layout_weights` rows cold-start — accepted, the
  layout bandit had collapsed to one arm on the sites this exists to fix.

## 0.8.0

### Minor Changes

- af5b76c: New `@sentientui/policy/taxonomy` subpath: the two-layer section vocabulary.

  `SEMANTIC_PARENTS` (the 10-value enum the layout bandit orders on — the only
  layer that can ever widen the arm space), the ~44-topic `TOPICS` table with
  per-topic default `role` (converter / persuader / structural), and
  `parentOfTopic` / `roleOfTopic` with fail-safe defaults (unknown topic →
  `generic` parent, `persuader` role — never `structural`, which would pin real
  content in place).

  Deliberately a subpath, not the barrel: the barrel is reachable from the
  always-on snippet bundle and the topic table costs ~405 bytes gzip that the
  browser never reads. The map initialiser carries `/* @__PURE__ */` so bundlers
  can drop it — keep that annotation when editing.

## 0.7.0

### Minor Changes

- c69cdaf: New exports `pickFromWeights` and `WEIGHTS_FALLBACK_PRIOR_PULLS`: the React SDK's degraded-fallback weights picker, moved here verbatim so all shrinkage variants live in the pinned package. Deliberately keeps its historical fixed 5-pseudo-pull zero prior (documented and pin-tested as distinct from `SHRINKAGE_M = 20`); unifying the constants would be a serving-behavior change requiring a replay.

## 0.6.2

### Patch Changes

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

## 0.6.1

### Patch Changes

- 47584a5: Snippet section reordering (Track B1.1) and vocabulary-validated persona preview (B1.2).

  `window.sentient.sections: ['#hero', '#pricing', '#faq']` declares the page sections eligible for adaptive reordering, as CSS selectors in the theme's natural order — mirroring the React `sections` prop. Selectors that resolve on the page ride the existing decide call, and the served `layoutOrder` is applied only under fail-safe bounds: every id must resolve to exactly one element, all elements must share one parent, and the order must be a permutation of what can move — anything else applies nothing, silently. Return visits pre-paint the last served order from the local snapshot (bounded against the current DOM), so a learned layout doesn't flash natural-order first.

  The `?sentient_persona=` preview banner now trusts the server's vocabulary echo: a recognized key shows its display name; an unrecognized value says "isn't in your personas — showing the default experience" instead of claiming a persona `/v1/explain` never simulated.

## 0.6.0

### Minor Changes

- 2ef60e1: Declared personas: tell the engine the role your app already knows, and the layout/slot optimizer learns per role.

  - **core**: `init({ persona: 'admin' })` — sent on the session upsert and every decide; SSR helpers (`preloadAssignments`/`preloadDecisions`) accept the same option. Declared personas are served at full confidence, overriding the inferred one; values not in the project's persona vocabulary are ignored server-side and surfaced in the dashboard.
  - **react**: `persona` prop on `<AdaptiveProvider>`/`<AdaptiveRoot>`, forwarded through both SSR paths. Stable for the session (decisions are locked per visit); changing it after init warns in dev.
  - **snippet**: `window.sentient.persona` — a vocabulary key string, or a function evaluated once at init (fail-safe: a throwing or non-string getter is treated as undeclared).
  - **policy**: new `resolvePersona` (declared beats inferred), `decisionPersona`, `DEFAULT_PERSONA_VOCABULARY`, `PERSONA_KEY_RE`, `RESERVED_PERSONA_KEYS`; the layout heuristics accept any vocabulary persona (custom personas cold-start on the natural order, like `unknown`).

## 0.5.0

### Minor Changes

- 5a2515f: Partial pooling shrinks toward the parent's MEAN, not its sample size.

  `shrunkPosterior` added `w * pooled.alpha` with `w = m / (m + cell.exposures)`,
  which folded the parent's counts into the child. Because the write path expands
  every trial into the child, both marginals and the global row, the parent grows
  with total project volume — so a cell needed roughly `sqrt(m * N_parent)`
  exposures before its own rate mattered (~1,400 against a 100k-exposure parent,
  not the ~20 `SHRINKAGE_M` advertises), and it inherited the parent's
  _confidence_ along with its rate. A 20-exposure cell emerged with a posterior
  standard deviation of 0.002 against the ~0.09 its evidence justifies, which
  makes Thompson Sampling draws effectively deterministic and collapses
  exploration in exactly the thin cells that need it.

  The prior is now worth a fixed `m` pseudo-observations at the parent's rate,
  itself damped by the parent's own mass so an uninformative parent barely shrinks
  at all.

  Also adds `broadestValueCell`. EV serving read the value posterior by summing a
  variant's hierarchy rows, counting every real order 2–4× depending on the
  persona mix. The average survived that, but the shrinkage weight detached at ~5
  orders instead of `EV_SHRINK_K = 20`, by a factor that varied per arm.

  **Minor rather than patch, deliberately.** Two reasons a patch would mislead
  anyone pinned to `~0.4.0`:

  - `shrunkPosterior`'s first argument no longer takes `exposures` — it is
    `{ alpha, beta }`. The field only fed the removed weighting term, but an
    object literal passing it is now a compile error.
  - More importantly, the same inputs return **different numbers**. This changes
    live serving behaviour, not just types. Validate with
    `apps/api/scripts/replay-pooling.ts` and stage the rollout.

## 0.4.0

### Minor Changes

- 6dade33: New `ev` module for expected-value ranked serving: `shrunkAvgValue` (EB-shrinks a cell's average order value toward a reference, `EV_SHRINK_K = 20`) and `sampleArmEv` (Thompson draw × shrunk value; with no value data it degrades exactly to CVR ranking), plus the `EvArm`/`ValueCell` types.

## 0.3.3

### Patch Changes

- 8ecd00f: Point `repository` metadata at the public source mirror (`github.com/SentientUI/sdk`)
  so the "Repository" link on npm resolves, and add a `bugs` URL for issue reporting.
  No runtime changes.

## 0.3.2

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

## 0.3.1

### Patch Changes

- 150cd26: Document that bandit sampling and layout selection default to non-deterministic `Math.random` and accept a seeded PRNG (`rand`) for reproducible, replayable decisions.

## 0.3.0

### Minor Changes

- 6a09ead: Add hierarchical partial-pooling engine (`pooledPosterior`, `weightCellsFor`, `POOL_ALL`) for persona × segment bandit serving.

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
