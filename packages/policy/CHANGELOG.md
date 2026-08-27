# @sentientui/policy

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
