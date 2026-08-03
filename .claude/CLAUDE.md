# SentientUI SDKs — agent notes

This repository is the public, source-visible mirror of the SentientUI client SDKs
(`@sentientui/core`, `react`, `snippet`, `cli`, `policy`). It is synced from a private
monorepo, which is the source of truth for everything published to npm.

## What this is

- Thin client packages for [SentientUI](https://sentient-ui.com), an adaptive UI
  personalization platform. The optimizer, persona clustering, worker, and management API are
  hosted and private — the SDKs are useless without them.
- `packages/*/src` mirrors the monorepo package sources. `packages/*/CHANGELOG.md` is the
  primary "what changed" record. Sync commits are tagged with released versions.

## For contributors / agents working here

- There is **no publish flow in this repo** and no monorepo history. Do not add release
  workflows, changesets tooling, or CI that publishes.
- Changes are reviewed here and ported to the private monorepo on accept (see
  `CONTRIBUTING.md`); the monorepo release publishes to npm.
- These packages ship to browsers — mind bundle size, especially `snippet` (hard gzip budget)
  and `core`.

## Do not

- Add secrets, keys, `.env` files, or customer data to this repo.
- Report or discuss security vulnerabilities in public issues/PRs — use private reporting
  (`SECURITY.md`).
- Change a package's public API surface without noting the behavior change for the port.
