# @sentientui/policy

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
