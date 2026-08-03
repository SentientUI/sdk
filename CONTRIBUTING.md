# Contributing

Thanks for helping improve the SentientUI SDKs.

## How this repo works (please read first)

**This repository is a mirror.** The SDK source lives in a private monorepo, which is the
source of truth for everything published to npm. This repo is a source-visible window synced
from it — there is no publish flow here, and we can't click **Merge** on your PR directly
(the git histories differ).

We still review and accept contributions here. When we accept a change, we **port it to the
monorepo**, add a changeset, run the checks, and release it to npm. Your commit lands in the
next sync with attribution (a `Co-authored-by:` trailer on the monorepo commit). We then close
your PR with a note like _"merged via monorepo, released in x.y.z — thanks!"_

So: a **closed** PR here does **not** mean rejected. Check the closing comment for the release
version.

## Reporting bugs

Open an issue using the **Bug report** template. The single most useful line is the **exact
package version** (`@sentientui/react@0.18.1`), plus framework/browser and a minimal repro.

If the problem is in the hosted backend (optimizer, API, dashboard) rather than the SDK, we'll
label it `upstream` and track the fix privately — the SDK code here may be working correctly.

## Pull requests

1. Fork this repo and branch from `main`.
2. Keep changes focused — one fix or feature per PR.
3. Match the surrounding code style; these packages ship to browsers, so mind bundle size
   (the snippet has a hard gzip budget).
4. Describe the change and how you tested it. Note any behavior change.
5. Open the PR against `main`. We'll review here and port on accept (see above).

We can't run the monorepo's full CI on your fork, so clear reproduction steps and a description
of your own testing carry the review.

## Security

Do **not** open a public issue or PR for a vulnerability. Follow [SECURITY.md](./SECURITY.md)
(private reporting).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
