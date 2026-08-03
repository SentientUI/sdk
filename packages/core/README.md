# @sentientui/core

Framework-agnostic JavaScript SDK for [SentientUI](https://sentient-ui.com) — a Thompson Sampling bandit + persona/portrait engine that automatically surfaces the best-performing variant for each visitor. Learning runs on the SentientUI hosted API.

> Most users should install **`@sentientui/react`** instead — it bundles this package and adds the SSR-safe `<AdaptiveRoot>`, `<Adaptive>`, and hooks. Use `@sentientui/core` directly only if you are not building with React.

## Installation

```bash
npm install @sentientui/core
```

## Quick start

```ts
import { init } from '@sentientui/core';

const client = init({
  apiKey: 'pk_your_key',          // from sentient-ui.com → Settings
  context: 'saas',                // 'landing' | 'ecommerce' | 'saas' | 'marketplace'
});

// Get a variant assignment for a component (returns null during SSR)
const result = await client.assign('hero_headline', ['control', 'variant_b']);
console.log(result?.variantId);   // e.g. 'variant_b'
console.log(result?.content);     // managed text content if the variant is WYSIWYG-managed

// Credit the variant served for a component when the visitor converts
// (feeds the per-variant CVR funnel — no variantId plumbing needed)
client.componentGoal('hero_headline', 'trial_started');

// Or record a session-level funnel goal not tied to any component
client.goal('trial_started', { plan: 'pro' });
```

`init()` returns a no-op client during SSR (`typeof window === 'undefined'`) or when `consent` is `false`. When `apiKey` does not start with `pk_`, it returns a no-op client in production builds, or the keyless local-mode client in development builds (see "Keyless local mode" below). The hosted ingest URL (`https://api.sentient-ui.com/v1/events`) is built in — no URL configuration required.

## API

### `init(config)` → `SentientClient`

| Option | Type | Description |
|--------|------|-------------|
| `apiKey` | `string` | Public API key (`pk_…`) from the SentientUI dashboard. |
| `context` | `'landing' \| 'ecommerce' \| 'saas' \| 'marketplace'` | Local label only — echoed in `debug` logs, never sent to the server. Analytics grouping comes from the project's context type configured in the dashboard. |
| `consent` | `boolean` *(default `true`)* | When `false`, returns a no-op client (no cookies, no events). **The default is `true`** — for GDPR-style opt-in, pass `false` until your banner is accepted (see `preConsentBehavior`). |
| `preConsentBehavior` | `'control' \| 'statistical_winner'` | What to render while `consent` is `false`: `'control'` (the default — shows `variantIds[0]`), or the read-only statistical winner via `/v1/winner` (no session, no events). |
| `respectDoNotTrack` | `boolean` *(default `true`)* | Honors the browser DNT signal — overrides `consent: true` and blocks `grantConsent()`. |
| `initialAssignments` | `Record<string, string>` | SSR-preloaded assignments. Seeds the cache so `assign()` returns without a network call for listed code variants. (Managed-text components still fetch once when the seed carries no content.) |
| `sessionSegment` | `string` | Segment from SSR (`device:source`). Must match the value used in `preloadAssignments`. |
| `ssrSessionId` | `string` | Session ID minted during SSR (from `readSessionCookie`) so server and client share one session. |
| `userId` | `string` | Optional cross-session identity. Persists portraits across sessions for the same user. |
| `country` | `string` | ISO 3166-1 alpha-2 country code, if you already know it server-side. |
| `debug` | `boolean` | Logs events to the console and exposes `window.__sentient`. |
| `localMode` | `'auto' \| boolean` | Keyless local engine. `'auto'` (default) enables it only under the `development` export condition; production builds without a key short-circuit to defaults with one `console.error`. |
| `initialSlots` | `Record<string, string \| Record<string, string>>` | SSR-preloaded slot results (from `preloadDecisions`/`loadAdaptiveDecision`). |
| `initialPersona` | `{ persona: string; confidence: number }` | SSR-preloaded persona, so client and server agree on first paint. |

### `client.assign(componentId, variantIds?)` → `Promise<AssignResult | null>`

Asks the hosted bandit for a variant. Cached locally per `(componentId, segment)` — repeat calls hit the cache. Returns `null` during SSR or when the session has no ID.

```ts
type AssignResult = {
  variantId: string;
  assignmentTtlMs: number;
  content?: string;   // populated when the variant is dashboard-managed (WYSIWYG)
};
```

### `client.track(event)`

Queues an event for batched ingest. Events flush every 5 s and on `visibilitychange` / page unload (via `fetch` with `keepalive: true`).

### `client.goal(name, metadata?, weight?, stepIndex?)`

Fires a named goal for the current session. Used for cross-component conversions (e.g. `'trial_started'`, `'purchase_completed'`) where you cannot scope the reward to a single `<Adaptive>`.

- `weight` (0–1, default `1.0`) — partial reward value. Use values < 1 for funnel steps that precede the final conversion. Step weights are summed (capped at 1.0 per session) and credited when the visit is finalized, about 30 minutes after the visitor goes inactive — not instantly.
- `stepIndex` (default `0`) — position in the funnel for analytics grouping.

> **Which goal method?** `goal()` is **session-level** — it POSTs to `/v1/goals` with no component/variant, so it appears in funnel charts but **not** the per-variant CVR breakdown. For variant experiments, prefer **`componentGoal()`** (below) or the declarative `<Adaptive goal={…}>` prop, both of which attribute the conversion to the served variant.

### `client.componentGoal(componentId, goalType, opts?)`

Records a conversion **attributed to the variant currently served** for `componentId`, so it feeds the per-variant CVR funnel. Resolves the served variant from the local assignment cache — you don't pass `variantId` or `projectId`. Emits a `goal_achieved` event (the same signal `<Adaptive goal>` fires automatically).

```ts
client.componentGoal('hero_headline', 'hero_contact', {
  reward: 1,                       // 0–1, default 1
  metadata: { method: 'whatsapp' } // merged into the event payload
});
```

No-ops (with a `debug` warning) if the component has not been assigned yet — render its `<Adaptive>` / call `assign()` first. Prefer this over a hand-rolled `client.track({ eventType: 'goal_achieved', … })`, which requires you to thread the `variantId` through yourself. In React, use the [`useAdaptiveGoal`](../react/README.md#useadaptivegoalcomponentid) hook.

### `client.identify(userId)`

Attaches a stable user ID to the session. On the link, the server copies the highest-reliability portrait from the user's other sessions onto this one, so portraits and cluster assignment carry forward across devices for the same `userId`.

### `client.getAssignment(componentId, segment)`

Synchronously returns the cached assignment, or `null` if not yet assigned. Use when you need a non-async lookup.

### `client.getGraph()`

Returns the current `GraphSnapshot` (page nodes captured by the optional graph scanner — see "Optional: graph mode" below). Permanently returns an empty snapshot on the lean client; graph mode must be enabled at `init` time.

### `client.dispose()`

Routine cleanup: stops the flush timer and unload listeners (with a final flush) but **keeps the visitor identity, decision snapshot, and retry bucket**. Use this when a component or provider that owns the client unmounts or re-initializes — the visitor must survive it. `<AdaptiveProvider>` calls it for you on cleanup.

### `client.destroy()`

Everything `dispose()` does, plus **deletion of the visitor identity** — the 365-day `_snt_uid` cookie, local/session storage keys, the decision snapshot, and the persisted retry bucket. This is a consent-revocation/forget-me teardown, not a page-unload cleanup: calling it on every unload makes each visit a brand-new visitor and defeats "Visit 1 learns, Visit 2 converts". For unload, do nothing — the SDK already flushes on `visibilitychange`/`beforeunload` automatically.

## SSR helpers

```ts
import { preloadAssignments, readSessionCookie } from '@sentientui/core/server';

// In your server loader / getServerSideProps / Server Component.
// `cookies` must expose `get(name)` — Next.js `req.cookies`, `headers().cookies()`, or any
// object with the same shape.
const sessionId = readSessionCookie(cookies) ?? crypto.randomUUID();

const initialAssignments = await preloadAssignments(
  [
    { id: 'hero_headline', variantIds: ['control', 'variant_b'] },
    { id: 'pricing_cta',   variantIds: ['monthly', 'annual_first'] },
  ],
  sessionId,
  {
    apiKey:  process.env.NEXT_PUBLIC_SENTIENT_API_KEY!,
    baseUrl: 'https://api.sentient-ui.com/v1',
    origin:  process.env.APP_ORIGIN,           // must be in the project's allowed origins
    userAgent,                                 // from request headers, aligns segment with the client
    referer,
  },
);
```

Pass `initialAssignments` and the same `sessionSegment` to `init()` on the client to prevent hydration mismatches.

For pages with a section layout, use `preloadDecisions` instead — same options, plus a `sections: string[]` request field. The return value carries both `assignments` and `layoutOrder`.

## decide() — slots, layout, and persona in one call

```ts
const outcome = await client.decide({
  sections: ['hero', 'pricing', 'faq'],                       // optional page-order request
  slots: [
    { id: 'hero', dims: { tone: ['calm', 'urgent'] } },       // token slot (first value = baseline)
    { id: 'pricing-area', arms: ['standard', 'social_first'] } // enumerated slot
  ],
});
// outcome: {
//   layoutOrder: string[] | null,
//   assignments: Record<string, string>,
//   slots: { hero: { tone: 'urgent' }, 'pricing-area': 'social_first' },
//   persona: 'buyer', confidence: 0.8,
// }
client.getSlotResult('hero');   // sync read of a decided slot
client.getPersona();            // { persona, confidence, band: 'low' | 'medium' | 'high' }
```

Decisions are locked per session. Apply dims results as `data-<dim>` attributes and style them
with CSS. At least one of `sections` / `components` / `slots` must be present.

## Decision snapshot (pre-paint on return visits)

Every decide writes a snapshot (persona, confidence band, slot results, layout order) to
localStorage under `_snt_snap:<apiKey>`. On the next visit, apply it before paint:

```ts
import { readSnapshot, writeSnapshot, renderPrePaintScript } from '@sentientui/core';

// In your HTML head (server-rendered), inline this script to apply the snapshot pre-paint:
const inline = renderPrePaintScript('pk_your_key');
```

First visit renders your baseline; the return visit adapts with zero flicker — Visit 1 learns,
Visit 2 converts.

## Keyless local mode

Without a valid `pk_…` key, development builds simulate decisions locally — deterministic per
session, zero network — via the separate entry `@sentientui/core/local`:

```ts
import { createLocalEngine } from '@sentientui/core/local';

const engine = createLocalEngine({ sessionId, forcedPersona: 'deal_seeker' });
const outcome = engine.decide({ slots: [{ id: 'hero', dims: { tone: ['calm', 'urgent'] } }] });
```

The local engine ships behind `development`/`production` export conditions — production bundles
physically contain none of it. Production without a key short-circuits to defaults and logs one
`console.error` per page. Force personas with `?sentient_persona=`.

## Optional: graph mode

`@sentientui/core/graph` is a separate, tree-shakable entry containing the graph-capable client (DOM scanner + graph sync: component-to-component edges + 2-hop reward propagation). A bare `import('@sentientui/core/graph')` has **no effect** — the entry exports its own `init`, which you must call with `graph: true` **instead of** the lean `init`:

```ts
import { init } from '@sentientui/core/graph';

const client = init({ apiKey: 'pk_…', context: 'saas', graph: true });
```

A client created by the lean `init` can never activate graph mode later (`getGraph()` stays empty). The lean bundle is ~8 KB gzip (CI budget: 10 KB); graph adds ~3–4 KB gzip on top of the lean bundle (combined CI budget: 16 KB).

> **Using `@sentientui/react`?** Don't import this entry yourself — the provider
> enables graph scanning by default (opt out with `enableGraph={false}` on
> `AdaptiveProvider` / `AdaptiveRoot`) and wires the graph-capable `init()` into
> its single client for you; calling `init` from this entry alongside the
> provider would create a second client.

There is also a lazy `@sentientui/core/engagement` entry (`startEngagementCapture`)
that classifies page sections and records per-section attention (dwell/scroll) to
power audience profiles. The React provider and the no-code snippet start it by
default; it never runs for a DNT/GPC or consent-gated visitor.

## Local overrides (development — `@sentientui/react` only)

Dev overrides are implemented by the **React SDK**, not this package — `client.assign()` here does not read them. With `@sentientui/react`:

```
# URL parameter (stackable)
https://yourapp.com?sentient_variant=hero_cta:variant_a

# Or before SDK init:
window.__sentient_overrides = { hero_cta: 'variant_a' };
```

While a variant is forced, the React components record nothing — no exposure, no goals, no micro-signals — so the bandit's weights are untouched.

## Docs

Full reference: [sentient-ui.com/docs](https://sentient-ui.com/docs).

## License

MIT
