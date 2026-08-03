# @sentientui/cli

Sets up [SentientUI](https://sentient-ui.com) adaptive UI in an existing React app.

```bash
npx @sentientui/cli init
```

## What `init` does

1. **Detects your framework** (Next.js App/Pages Router, Vite, Remix, CRA) and package manager (pnpm, yarn, bun, npm).
2. **Installs `@sentientui/react`** with your package manager.
3. **Writes `.env.local`** with the right variable for your framework (`NEXT_PUBLIC_SENTIENT_API_KEY` or `VITE_SENTIENT_API_KEY`). Never clobbers: if the variable is already assigned — even empty — the file is left untouched.
4. **Scaffolds `components/adaptive-example.tsx`** (or `src/components/` when your app uses `src/`) — a working style-rung hero using `useAdaptiveTokens`. Skipped if the file already exists.
5. **Prints the wrap instructions** for your framework: the `<AdaptiveRoot>` / provider snippet to add to your layout, and what to do next.

## What it does NOT do

`init` **never edits your layout or any existing file.** Nothing adapts until you do the wrap-and-mount step it prints — add the provider snippet to your root layout and mount the example component yourself.

## Flags

| Flag | Description |
|------|-------------|
| `--key pk_...` | Your public API key, written into `.env.local`. Omit it to leave the value empty — the SDK then runs in keyless local mode (decisions simulated on-device, nothing sent), so you can build and style before creating an account. |
| `--yes` / `-y` | Accepted for npx muscle memory; `init` has no prompts, so this is already the default behavior. |

## After init

Run your dev server and preview personas locally with `?sentient_persona=buyer` (or `researcher` / `deal_seeker` / `browser`) — this override works in keyless local mode.

Full component and hook reference: the [`@sentientui/react` README](https://www.npmjs.com/package/@sentientui/react).

## License

MIT
