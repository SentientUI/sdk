# SentientUI SDKs

Open source client SDKs for [**SentientUI**](https://sentient-ui.com) — an adaptive UI
personalization platform. Your UI learns what converts for each visitor: **Visit 1 learns,
Visit 2 converts.**

These packages are the client side of SentientUI. They observe behavior, request decisions,
and render learned variants. The optimizer, persona clustering, and management API are hosted;
you don't run them. Everything a browser executes lives in this repo — read it, audit it, open
an issue.

> **This repository is a source-visible mirror.** It is synced from a private monorepo, which
> stays the source of truth for releases. See [CONTRIBUTING.md](./CONTRIBUTING.md) for how we
> review and merge changes here.

## Packages

| Package | npm | What it is |
| --- | --- | --- |
| [`@sentientui/core`](./packages/core) | [npm](https://www.npmjs.com/package/@sentientui/core) | Framework-agnostic client: session tracking, variant assignment, adaptive slots, persona decisions. SSR-safe. |
| [`@sentientui/react`](./packages/react) | [npm](https://www.npmjs.com/package/@sentientui/react) | React SDK — `<Adaptive>` components and hooks that learn what converts per visitor. |
| [`@sentientui/snippet`](./packages/snippet) | [npm](https://www.npmjs.com/package/@sentientui/snippet) | One script tag for non-React sites: persona attributes + adaptive style tokens. Plain CSS does the rest. |
| [`@sentientui/cli`](./packages/cli) | [npm](https://www.npmjs.com/package/@sentientui/cli) | `npx @sentientui/cli init` — sets up the React SDK in an existing app. |
| [`@sentientui/policy`](./packages/policy) | [npm](https://www.npmjs.com/package/@sentientui/policy) | Pure decision-policy functions shared by the API and the keyless local engine. |

The MCP server lives in its own mirror: [`SentientUI/mcp`](https://github.com/SentientUI/mcp)
([`@sentientui/mcp`](https://www.npmjs.com/package/@sentientui/mcp)).

## Shopify app

[`apps/shopify`](./apps/shopify) is the source of the SentientUI Shopify app — the pieces a
merchant's store executes (the theme app embed carrying the snippet one-liner, the checkout
web pixel) plus the webhook mappers that forward server-truth orders and refunds to the
SentientUI API. It is not published to npm; the app itself is installed from the Shopify
App Store.

## Quickstart

**React**

```bash
npx @sentientui/cli init
```

This detects your framework, installs `@sentientui/react`, writes env config, and prints the
provider snippet to add to your root layout. Full reference: [`packages/react`](./packages/react).

**Any site (no build step)**

```html
<script>
  window.sentient = {
    apiKey: 'pk_your_key',
    context: 'landing',
    slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } },
  };
</script>
<script src="https://unpkg.com/@sentientui/snippet/dist/snippet.global.js" defer crossorigin="anonymous"></script>
```

For production, pin an exact version and add a Subresource Integrity hash
(`integrity="sha384-…"`) or self-host the file — see [`packages/snippet`](./packages/snippet)
for how to compute it. Don't ship a placeholder `integrity` value: a hash that doesn't match
makes the browser refuse to run the script.

## Versioning & support

- **Pre-1.0, latest only, fix-forward.** We support the most recent release of each package.
  Breaking changes land in **minor** bumps and are called out at the top of each package
  `CHANGELOG.md`.
- Each sync commit is **tagged with the released version** (e.g. `react@0.18.1`) so you can
  browse the exact source for the version you installed.
- The mirror may lag a release or two behind npm; the tags make the lag visible and honest.

## Privacy

SentientUI observes visitor behavior to personalize UI. It honors **Do Not Track** and
**Global Privacy Control**, and there is **no cross-customer model** — one site's data never
personalizes another's. This is why the client is open: read exactly what gets collected. See
the [Privacy Policy](https://sentient-ui.com/privacy) and, in each package, the data it sends.

## Contributing

Bug reports and PRs are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). Security issues go
through [private reporting](./SECURITY.md), never a public issue.

## License

[MIT](./LICENSE) © Carlos Sánchez Campos / SentientUI
