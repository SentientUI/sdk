# @sentientui/cli

Sets up [SentientUI](https://sentient-ui.com) adaptive UI in an existing React app.

```bash
npx @sentientui/cli init
```

## What `init` does

1. **Detects your framework** (Next.js App/Pages Router, React Router v7, Remix, Gatsby, Astro, Vite, CRA) and package manager (pnpm, yarn, bun, npm). The package manager is read from the nearest lockfile, `pnpm-workspace.yaml` or `packageManager` field, walking up to the repository root — so inside a monorepo package it uses the workspace's manager, not npm.
2. **Installs `@sentientui/react`** with that package manager (skip with `--no-install`; the command is printed instead).
3. **Writes the env file** with the right variable for your framework: `NEXT_PUBLIC_SENTIENT_API_KEY` (Next.js), `VITE_SENTIENT_API_KEY` (Vite, Remix, React Router v7), `PUBLIC_SENTIENT_API_KEY` (Astro), `REACT_APP_SENTIENT_API_KEY` (CRA) in `.env.local`, or `GATSBY_SENTIENT_API_KEY` in `.env.development` (Gatsby does not read `.env.local`; copy it to `.env.production` for builds). Without `--key`, an existing assignment of the variable — even empty or commented out — leaves the file untouched. With `--key`, a differing active assignment is replaced in place with the new key; nothing else in the file changes.
4. **Scaffolds `components/adaptive-example.tsx`** (or `src/components/` when your app uses `src/`) — a hero wrapped in `<Adaptive id="hero-cta" goal="signup_click">`: your markup is the original, and versions are generated from the dashboard. Skipped if the file already exists.
5. **Prints the wrap instructions** for your framework: `<AdaptiveRoot>` (a Server Component, in `app/layout.tsx`) for the Next.js App Router, `wrapRootElement` in both `gatsby-browser` and `gatsby-ssr` for Gatsby, a provider inside each React island for Astro (Astro has no app-wide React root), `<AdaptiveProvider>` everywhere else, and what to do next.

## What it does NOT do

`init` **never edits your layout or any source file.** The only existing file it may change is the env file, and only as described above. Nothing adapts until you do the wrap-and-mount step it prints — add the provider snippet to your root layout and mount the example component yourself.

## Commands and flags

```bash
npx @sentientui/cli init      # set up SentientUI in this app
npx @sentientui/cli --help    # full usage
npx @sentientui/cli --version # the installed version, on stdout
```

| Flag | Description |
|------|-------------|
| `--key pk_...` | Your public API key, written into the env file. Omit it to leave the value empty — the SDK then runs in keyless local mode (decisions simulated on-device, nothing sent), so you can build and style before creating an account. |
| `--consent <preset>` | Your cookie banner: `cookiebot`, `onetrust`, `cookieyes`, `tcf`, `google-consent-mode` or `shopify`. The printed snippet waits for it (`consentFrom`) before storing or measuring anything. Omit it and tracking starts on first paint for every visitor — EU/UK visitors need consent first. |
| `--no-install` | Skip installing `@sentientui/react` and print the install command instead — for workspace layouts or registries detection cannot handle. |
| `--yes` / `-y` | Accepted for npx muscle memory; `init` has no prompts, so this is already the default behavior. |
| `--help` / `-h` | Print usage and exit 0. |
| `--version` / `-v` | Print the version and exit 0. |

`--help` and `--version` print to stdout and exit 0, so they are safe to pipe.
An unknown command prints usage to stderr and exits 1.

## After init

Mount the example on a page, run your dev server, and load it with `?sentient_persona=a`. Check that `<html>` now carries `data-sentient-persona="a"` (in the devtools console: `document.documentElement.dataset.sentientPersona`), then reload with `?sentient_persona=b` and see `"b"`. In keyless local mode any key works. The example hero itself looks the same under both values, and that is expected: it shows your original until a version is published from the dashboard, which needs a real `pk_` key. Against a real project, use a persona key you declared (e.g. `admin`); projects start with no personas.

Full component and hook reference: the [`@sentientui/react` README](https://www.npmjs.com/package/@sentientui/react).

## More

- [Developer resources](https://sentient-ui.com/docs/developers) — REST API, OpenAPI spec, MCP server, webhooks
- [CLI reference](https://sentient-ui.com/docs/developers#cli)

## License

MIT
