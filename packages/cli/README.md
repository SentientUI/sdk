# @sentientui/cli

Sets up [SentientUI](https://sentient-ui.com) adaptive UI in an existing React app.

```bash
npx @sentientui/cli init
```

## What `init` does

1. **Detects your framework** (Next.js App/Pages Router, Vite, Remix, CRA) and package manager (pnpm, yarn, bun, npm).
2. **Installs `@sentientui/react`** with your package manager.
3. **Writes `.env.local`** with the right variable for your framework (`NEXT_PUBLIC_SENTIENT_API_KEY` or `VITE_SENTIENT_API_KEY`). Never clobbers: if the variable is already assigned — even empty — the file is left untouched.
4. **Scaffolds `components/adaptive-example.tsx`** (or `src/components/` when your app uses `src/`) — a hero wrapped in `<Adaptive id="hero-cta" goal="signup_click">`: your markup is the original, and versions are generated from the dashboard. Skipped if the file already exists.
5. **Prints the wrap instructions** for your framework: `<AdaptiveRoot>` (a Server Component, in `app/layout.tsx`) for the Next.js App Router, `<AdaptiveProvider>` everywhere else, and what to do next.

## What it does NOT do

`init` **never edits your layout or any existing file.** Nothing adapts until you do the wrap-and-mount step it prints — add the provider snippet to your root layout and mount the example component yourself.

## Commands and flags

```bash
npx @sentientui/cli init      # set up SentientUI in this app
npx @sentientui/cli --help    # full usage
npx @sentientui/cli --version # the installed version, on stdout
```

| Flag | Description |
|------|-------------|
| `--key pk_...` | Your public API key, written into `.env.local`. Omit it to leave the value empty — the SDK then runs in keyless local mode (decisions simulated on-device, nothing sent), so you can build and style before creating an account. |
| `--consent <preset>` | Your cookie banner: `cookiebot`, `onetrust`, `cookieyes`, `tcf`, `google-consent-mode` or `shopify`. The printed snippet waits for it (`consentFrom`) before storing or measuring anything. Omit it and tracking starts on first paint for every visitor — EU/UK visitors need consent first. |
| `--yes` / `-y` | Accepted for npx muscle memory; `init` has no prompts, so this is already the default behavior. |
| `--help` / `-h` | Print usage and exit 0. |
| `--version` / `-v` | Print the version and exit 0. |

`--help` and `--version` print to stdout and exit 0, so they are safe to pipe.
An unknown command prints usage to stderr and exits 1.

## After init

Run your dev server and preview personas locally with `?sentient_persona=a`, then `?sentient_persona=b` — in keyless local mode any key works, and the two should render differently. Against a real project, use a persona key you declared (e.g. `admin`); projects start with no personas.

Full component and hook reference: the [`@sentientui/react` README](https://www.npmjs.com/package/@sentientui/react).

## More

- [Developer resources](https://sentient-ui.com/docs/developers) — REST API, OpenAPI spec, MCP server, webhooks
- [CLI reference](https://sentient-ui.com/docs/developers#cli)

## License

MIT
