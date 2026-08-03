# @sentientui/react

React SDK for [SentientUI](https://sentient-ui.com) — the adaptive ladder. Declare bounded
variations (styles, content, arrangement order); a persona-keyed optimizer on the hosted API
learns which one converts best for each visitor type. Visit 1 learns; Visit 2 converts.

## Installation

```bash
npm install @sentientui/react     # or: npx @sentientui/cli init (installs + writes .env.local + an example component)
```

## 2-minute start (no account)

```bash
npx @sentientui/cli init
# then follow its printed instructions: wrap your app with <AdaptiveRoot> (or
# <AdaptiveProvider>) and mount the generated components/adaptive-example.tsx
npm run dev
# open http://localhost:3000?sentient_persona=buyer — the example adapts
```

The CLI installs the package, writes `.env.local`, and generates an example component — it does
**not** edit your layout, so nothing adapts until you do the wrap-and-mount step it prints.

With no API key the SDK runs in keyless **local mode**: deterministic simulated decisions, zero
network. Add a `pk_…` key from [sentient-ui.com](https://sentient-ui.com) to learn from real
traffic:

```bash
# .env.local
NEXT_PUBLIC_SENTIENT_API_KEY=pk_your_key
```

## Setup

Wrap your root layout (Next App Router — server component):

```tsx
// app/layout.tsx
import { AdaptiveRoot } from '@sentientui/react/next';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <AdaptiveRoot
          apiKey={process.env.NEXT_PUBLIC_SENTIENT_API_KEY!}
          appOrigin={process.env.NEXT_PUBLIC_APP_URL!}
          context="saas"
        >
          {children}
        </AdaptiveRoot>
      </body>
    </html>
  );
}
```

`suppressHydrationWarning` on `<html>` is required: an inline script (rendered by
`AdaptiveRoot` as its first child) sets the persona attributes before first paint, exactly like
the `next-themes` pattern. Other React apps (Vite, CRA, Remix, Pages Router) use
`<AdaptiveProvider>` from `@sentientui/react` with the same props — **plus
`<SentientPersonaScript />` rendered in your document `<head>`** if you want the Rung-1a persona
attributes: only that inline script (which `AdaptiveRoot` includes for you) writes
`data-sentient-persona` / `data-sentient-confidence` in hosted mode. Without it, an
`AdaptiveProvider` app gets everything except the persona CSS hooks. (Keyless local mode writes
the attributes itself, so the demo works either way — don't let that mask a missing script when
you add a real key.)

## The adaptive ladder

### Rung 0 — Observe

Install is the integration. The dashboard immediately shows who is arriving: persona mix, device
and traffic-source segments, engagement signals. The "Suggested next step" card tells you which
rung to climb next, with a copy-pasteable snippet.

### Rung 1 — Style (CSS only)

**1a. Persona attributes — zero declaration.** The SDK sets on `<html>`:

```
data-sentient-persona   = buyer | researcher | deal_seeker | browser | unknown
data-sentient-confidence = low | medium | high
```

Write plain CSS against them (the canonical block — safe defaults for every persona):

```css
/* Show each visitor type what it cares about. Confidence-gate bold treatments. */
html[data-sentient-persona='buyer'] .cta-primary { font-weight: 700; }
html[data-sentient-persona='researcher'] .spec-details { display: block; }
html[data-sentient-persona='deal_seeker'] .discount-banner { display: block; }
html[data-sentient-persona='browser'] .newsletter-nudge { display: block; }
html[data-sentient-confidence='low'] .discount-banner,
html[data-sentient-confidence='low'] .newsletter-nudge { display: none; }
```

In keyless local mode (development without a `pk_` key), force any persona with
`?sentient_persona=deal_seeker`. The override is not read in hosted (`pk_`) mode.

**1b. Adaptive tokens — learned.** Declare a bounded design space; the optimizer picks per
visitor type; values arrive as element-scoped `data-*` props (SSR-serialized — zero flicker):

```tsx
import { useAdaptiveTokens } from '@sentientui/react';

function Hero() {
  const t = useAdaptiveTokens('hero', {
    tone:   ['calm', 'urgent'],   // first value = baseline (what you show today)
    motion: ['none', 'pulse'],
  });
  return <section {...t.props} className="hero">…</section>;
  // t.props  → { 'data-sentient-slot': 'hero', 'data-tone': 'urgent', 'data-motion': 'pulse' }
  // t.tokens → { tone: 'urgent', motion: 'pulse' }
}
```

```css
.hero[data-tone='urgent'] .cta { font-weight: 700; }

/* Animation values are enum values whose CSS you own — always respect reduced motion: */
.hero[data-motion='pulse'] .cta { animation: pulse 2s infinite; }
@media (prefers-reduced-motion: reduce) {
  .hero[data-motion='pulse'] .cta { animation: none; }
}
```

Constraints: 1–4 dims, 2–6 values each, combinations ≤ 64. Enum values only — no arbitrary CSS.
Optional `{ goal: 'buy_click' }` third argument credits conversions to this element directly.

### Rung 2 — Swap (alternate content)

```tsx
import { useAdaptive } from '@sentientui/react';

function BuyBox() {
  const { variant, value, bind, fireGoal } = useAdaptive('buy-box', {
    variants: { calm: <CalmBuyBox />, urgent: <UrgentBuyBox /> },  // first key = baseline
    goal: 'buy_click',                                              // required
  });
  return <div {...bind}>{value}</div>;
}
```

`bind` (ref + data attributes) wires exposure tracking, goal listeners, and engagement signals —
attach it or the slot cannot learn (dev mode warns loudly if you don't). `<Adaptive>` is the
wrapper form of the same rung; `<AdaptiveText>` swaps dashboard-managed text.

### Rung 3 — Reorder (structure)

Region-scope — declared arrangements of keyed children only, never free permutation:

```tsx
import { AdaptiveGroup } from '@sentientui/react';

<AdaptiveGroup
  id="pricing-area"
  arrangements={{
    standard:     ['plans', 'faq', 'social'],   // first key = baseline
    social_first: ['social', 'plans', 'faq'],
  }}
  goal="plan_selected"
>
  <PlanGrid key="plans" />
  <Faq key="faq" />
  <Testimonials key="social" />
</AdaptiveGroup>
```

Page-scope — declare `sections` on `AdaptiveRoot` and read the order with `useLayoutOrder()`
(see the API reference below). Use `AdaptiveGroup` for a region, `sections` for the page.

Every decision is locked for the session — visitors never see the page reshuffle under them.

## API

### `<AdaptiveRoot>` (Next.js App Router — server component)

Imported from `@sentientui/react/next`.

| Prop | Type | Description |
|------|------|-------------|
| `components` | `Array<{ id: string; variantIds: string[] }>` *(optional, default `[]`)* | Components to preload server-side. `id` must match `<Adaptive id="…">`. Omit when the tree uses only slots/sections or assigns client-side. |
| `sections` | `string[]` *(optional)* | Page section IDs in default order. When provided, a single `POST /v1/decide` returns both layout order and assignments; `useLayoutOrder()` becomes available. |
| `apiKey` | `string` | `pk_…` key — used by both the browser SDK and server-side SSR requests. |
| `appOrigin` | `string` *(default `http://localhost:3001`)* | Your app origin (e.g. `https://yourapp.com`). Must be on the project's allowed-origins list. Always set in production. |
| `context` | `'landing' \| 'ecommerce' \| 'saas' \| 'marketplace'` | Type of product. Used for segment weighting and analytics grouping. |
| `consent` | `boolean` *(default `true`)* | Set `false` to skip SDK init (no cookies, no events). Flip to `true` after the visitor accepts. |
| `respectDoNotTrack` | `boolean` *(default `true`)* | Honor the browser's Do Not Track signal. When on and DNT is enabled, the SDK sets no cookies and sends no tracking data (overriding `consent: true`), and `grantConsent()` won't re-enable it. Set `false` to make your own consent gate authoritative. |
| `ssrFallback` | `'first' \| 'none'` *(default `'first'`)* | What to render in SSR HTML for components not in `components`. `'first'` is safe for SEO. |
| `timeoutMs` | `number` *(default `1000`)* | Server-side fetch timeout before falling back to the first variant. Typical decide is well under 150 ms; the full budget is only reached on a cold start or an API distant from your SSR host. |
| `debug` | `boolean` | Log assignment and event activity to the console. |

### `<AdaptiveProvider>` (any React app)

Accepts the same `apiKey`, `context`, `consent`, `ssrFallback`, `debug` props as `<AdaptiveRoot>`, plus `onAssignment` (not available on `<AdaptiveRoot>` — function props can't cross the RSC boundary) and:

| Prop | Type | Description |
|------|------|-------------|
| `initialAssignments` | `Record<string, string>` | SSR-preloaded assignments — the `assignments` field of `loadAdaptiveAssignments`' return value (not the whole object). |
| `ssrSessionId` | `string` | The `sessionId` field of `loadAdaptiveAssignments`' return value. Required with `initialAssignments` so the browser adopts the same session the server assigned — otherwise exposures and goals attach to a different session than the SSR assignment. |
| `sessionSegment` | `string` | Segment from SSR (`device:source`). Must match the value used in `loadAdaptiveAssignments`. |
| `initialLayoutOrder` | `string[] \| null` | Preloaded section order from `loadAdaptiveDecision` (for Pages-Router-style SSR with sections). |

### `<Adaptive>`

| Prop | Type | Description |
|------|------|-------------|
| `id` | `string` | Unique component identifier within your project. |
| `variants` | `Record<string, ReactNode>` | Map of variant ID → content. Any two or more keys; the bandit explores them all. |
| `goal` | `string \| GoalConfig` | Conversion goal. A string is a click-goal label; an object is an explicit `GoalConfig`. |
| `agentDataByVariant` | `Record<string, unknown>` *(optional)* | Structured data keyed by variant ID that AI agents can consume via `GET /v1/agent/layout`. Only the assigned variant's entry is sent to the server. Preferred over `agentData`. |
| `agentData` | `unknown` *(optional, deprecated)* | Deprecated in favour of `agentDataByVariant`. Single value stored once regardless of which variant is shown; kept for backward compatibility. |
| `clientOnly` | `boolean` | Render nothing on the server; resolve on the client only. Use for cookie-dependent slots. |

#### Goal types

```ts
// Any click inside the variant (button, a, role=button). The string is the analytics label.
goal="signup_click"

// Click only on elements matching a CSS selector inside the variant.
goal={{ type: 'click', selector: 'button.cta' }}

// 80% of the component visible in the viewport (IntersectionObserver, 0–1 scale).
goal={{ type: 'scroll_depth', threshold: 0.8 }}

// A <form> inside the variant fires submit.
goal={{ type: 'form_submit' }}

// Composite — all sub-goals must fire (in any order) before the reward is recorded.
goal={{
  type: 'composite',
  all: [
    { type: 'scroll_depth', threshold: 0.8 },
    { type: 'click' },
  ],
}}

// Weighted composite — each step fires immediately as it completes, with a fractional reward.
// Use for multi-step funnels where partial completion still signals quality.
// Steps are independent: step 2 can fire before step 1.
goal={{
  type: 'weighted_composite',
  steps: [
    { goal: { type: 'scroll_depth', threshold: 0.5 }, name: 'viewed_pricing', weight: 0.2 },
    { goal: { type: 'click' },                         name: 'clicked_cta',   weight: 0.4 },
    { goal: { type: 'form_submit' },                   name: 'signed_up',     weight: 1.0 },
  ],
}}
```

Each goal fires at most once per variant mount. `WeightedCompositeGoal` fires each step's reward independently; `CompositeGoal` waits for all sub-goals and fires reward `1.0` once.

### `<AdaptiveText>`

Lightweight text-only variant (renders an inline `<span>` wrapper by default — change it via the `component` prop; no automatic goal wiring). Useful when you publish text variants from the dashboard WYSIWYG.

```tsx
import { AdaptiveText } from '@sentientui/react';

<h1>
  <AdaptiveText id="hero_headline" default="Ship faster with SentientUI" />
</h1>
```

### `useAdaptiveTokens(id, dims, opts?)`

```ts
function useAdaptiveTokens(
  id: string,
  dims: Record<string, readonly string[]>,   // 1–4 dims × 2–6 values; first value = baseline
  opts?: { goal?: string | GoalConfig },
): { tokens: Record<string, string>; props: Record<string, string> };
// props keys: `data-${dim}` per dim, plus `data-sentient-slot`: id — goal
// wiring locates the slot's element through it, so always spread all of `props`.
```

Spread `props` onto the element you style. Values serialize through SSR markup — no flicker, no
hydration mismatch. Renaming a value is a cold start for that value's learning.

### `useAdaptive(id, config)`

```ts
function useAdaptive<T>(
  id: string,
  config: { variants: Record<string, T>; goal: string | GoalConfig },  // first key = baseline
): {
  variant: string;
  value: T;
  bind: { ref: (el: HTMLElement | null) => void; 'data-sentient-id': string; 'data-sentient-variant': string };
  fireGoal: (goalType?: string, opts?: ComponentGoalOptions) => void;
};
```

Headless Swap-rung hook. `goal` is required and `bind` must be attached to a rendered element —
learning needs both. Supersedes `useAssignment`.

### `<AdaptiveGroup>`

| Prop | Type | Description |
|------|------|-------------|
| `id` | `string` | Unique group identifier. |
| `arrangements` | `Record<string, string[]>` | Arrangement id → ordered child keys. First entry = baseline. |
| `baseline` | `string` *(optional)* | Explicit baseline arrangement id (defaults to the first key). |
| `goal` | `string \| GoalConfig` *(optional)* | Conversion goal credited to this group. |
| `children` | keyed `ReactNode`s | Every key referenced by an arrangement must exist. |

Reorders via React keys (DOM moves, state preserved). Declared orders only.

### Persona attributes (Rung 1a)

`AdaptiveRoot` renders an inline script (its first child) that sets `data-sentient-persona` and
`data-sentient-confidence` on `<html>` before first paint; the client SDK adopts those values
and never rewrites them mid-session. Requirements: `suppressHydrationWarning` on `<html>`,
`AdaptiveRoot` at the top of the tree. In keyless local mode (development without a `pk_` key),
override with `?sentient_persona=<persona>` — the parameter is ignored in hosted (`pk_`) mode.

### `useAssignment(componentId, variantIds)`

> **Deprecated** — use [`useAdaptive`](#useadaptiveid-config) instead; it carries the goal and exposure wiring `useAssignment` leaves to you. Kept for backward compatibility.

Lower-level hook when you need the variant ID inside your own render logic (e.g. full-page layout tests where `<Adaptive>`'s wrapper `<div>` would break a flex/grid layout).

```tsx
import { useAssignment, useSentient } from '@sentientui/react';

function Hero() {
  const client = useSentient();
  const { variantId, isLoading } = useAssignment('hero_cta', ['control', 'variant_a']);

  if (isLoading) return <Skeleton />;
  return variantId === 'variant_a' ? <AccentHero /> : <DefaultHero />;
}
```

When using `useAssignment` you are responsible for firing the goal — `<Adaptive>`'s automatic impression and goal tracking does not apply. Use [`useAdaptiveGoal`](#useadaptivegoalcomponentid) (recommended) or `client?.goal(name)` from `useSentient()`.

### `useAdaptiveGoal(componentId)`

Returns a `fireGoal(goalType, opts?)` callback that records a conversion **attributed to the variant currently served** for `componentId` — so it shows up in the per-variant CVR funnel with **no manual `variantId`/`projectId` plumbing**. Use it for imperative handlers (click, form submit, custom events) when you're not using the declarative `<Adaptive goal={…}>` prop.

```tsx
import { useAdaptiveGoal } from '@sentientui/react';

function HeroContact({ method }: { method: string }) {
  const fireContact = useAdaptiveGoal('hero_headline');
  return (
    <a href="tel:+1..." onClick={() => fireContact('hero_contact', { metadata: { method } })}>
      Call us
    </a>
  );
}
```

The served variant is resolved from the SDK's assignment cache (the same one `<Adaptive id="hero_headline">` populates), so render that component before firing. `opts` accepts `reward` (0–1, default 1) and `metadata`. This replaces hand-rolled helpers that call `client.track({ eventType: 'goal_achieved', componentId, variantId, … })` — you no longer need to pass or track the variant yourself.

### `useLayoutOrder()`

Returns the resolved persona-specific section order, or `null` when not configured / below confidence threshold. Always fall back to your default order.

```tsx
import { useLayoutOrder } from '@sentientui/react';

function Page() {
  const order = useLayoutOrder();
  const defaultOrder = ['hero', 'pricing', 'features', 'social_proof'];
  const sections: Record<string, React.ReactNode> = {
    hero: <Hero />, pricing: <Pricing />, features: <Features />, social_proof: <SocialProof />,
  };
  return <main>{(order ?? defaultOrder).map((id) => <Fragment key={id}>{sections[id]}</Fragment>)}</main>;
}
```

### SSR for Pages Router / custom SSR

```ts
import { loadAdaptiveAssignments } from '@sentientui/react/server';

export async function getServerSideProps({ req }) {
  const { assignments, sessionId } = await loadAdaptiveAssignments(
    [{ id: 'hero_cta', variantIds: ['control', 'variant_a'] }],
    {
      cookies: req.cookies,
      apiKey:  process.env.NEXT_PUBLIC_SENTIENT_API_KEY!,
      baseUrl: 'https://api.sentient-ui.com/v1',
      origin:  process.env.NEXT_PUBLIC_APP_URL,
    },
  );
  return { props: { initialAssignments: assignments, ssrSessionId: sessionId } };
}
```

Pass `assignments` as `initialAssignments` **and `sessionId` as `ssrSessionId`** on `<AdaptiveProvider>` in `_app.tsx` — the return value is `{ assignments, sessionId }`, and without `ssrSessionId` the browser starts a different session than the one the server assigned, so the preload silently does nothing and events attach to the wrong session. For pages with a `sections` layout, use `loadAdaptiveDecision` (same options shape, plus `sections: string[]`) — its return value carries both `assignments` and `layoutOrder`.

### Forwarding to your own analytics

```tsx
<AdaptiveProvider
  apiKey={process.env.NEXT_PUBLIC_SENTIENT_API_KEY!}
  context="saas"
  onAssignment={(componentId, variantId) => {
    posthog.capture('$feature_flag_called', { $feature_flag: componentId, $feature_flag_response: variantId });
    mixpanel.register({ [`variant_${componentId}`]: variantId });
  }}
>
  {children}
</AdaptiveProvider>
```

Fires at most once per component ID per page load. Full Segment / GA4 / Mixpanel recipes: see [sentient-ui.com/docs/integrations](https://sentient-ui.com/docs/integrations).

### Local overrides (development)

Force a variant without touching the bandit:

```
# URL parameter (stackable)
https://yourapp.com?sentient_variant=hero_cta:variant_a&sentient_variant=pricing:annual_first

# Or, before SDK init:
window.__sentient_overrides = { hero_cta: 'variant_a' };
```

Overrides bypass the bandit entirely — no events recorded, weights unchanged.

## Graph scanning & engagement capture (on by default)

DOM graph scanning and behavioral engagement capture are **on by default** — no props needed. The SDK:

- captures your page structure and auto-detects what each section is (pricing, hero, social proof, …) — explicit `data-sentient-type` attributes always win over the heuristic;
- records per-section attention (visible time + scroll depth), which is what powers audience profiles with zero tagging.

Both modules are loaded on demand after init, so the base bundle stays lean, and neither ever runs for a Do-Not-Track, Global Privacy Control, or consent-gated visitor (see Consent below).

Opt out per feature:

```tsx
<AdaptiveProvider apiKey="pk_…" context="saas" enableGraph={false} engagement={false}>
  <App />
</AdaptiveProvider>
```

Direct `@sentientui/core` users enable graph scanning by importing `init` from `@sentientui/core/graph` with `graph: true`, and engagement capture via `startEngagementCapture` from `@sentientui/core/engagement`.

## Consent management (GDPR)

By default the SDK initialises with `consent: true`, so tracking starts on first paint — opt-in consent is something you wire up, not the default. For GDPR-style opt-in, pass `consent={false}` until the visitor accepts your banner; no events are sent and no cookie is written while consent is false. To serve the best-performing variant while the cookie banner is pending (rather than freezing the UI), add `preConsentBehavior: 'statistical_winner'`:

```tsx
<AdaptiveProvider
  apiKey={process.env.NEXT_PUBLIC_SENTIENT_API_KEY!}
  context="saas"
  consent={hasConsent}
  preConsentBehavior="statistical_winner"
>
  {children}
</AdaptiveProvider>
```

Set `hasConsent` to `false` until the user accepts your cookie banner, then flip it to `true`. The provider re-initialises automatically and begins full tracking.

### Without React

```ts
import { init, grantConsent } from '@sentientui/core';

const client = init({
  apiKey: 'pk_...',
  context: 'saas',
  consent: false,
  preConsentBehavior: 'statistical_winner',
});

// After the user accepts the cookie banner:
grantConsent(); // upgrades client in place — no need to reassign
```

### OneTrust integration

```ts
window.addEventListener('OneTrustGroupsUpdated', () => {
  // C0002 = Analytics/Performance category in OneTrust
  if (window.OnetrustActiveGroups?.includes('C0002')) {
    grantConsent();
  }
});
```

### Cookiebot integration

```ts
window.addEventListener('CookiebotOnAccept', () => {
  if (window.Cookiebot?.consent?.statistics) {
    grantConsent();
  }
});
```

When `consent: false` without `preConsentBehavior`, the SDK is a complete no-op — no API calls, no cookies, nothing. The `preConsentBehavior: 'statistical_winner'` mode calls only `GET /v1/winner`, a read-only endpoint that returns the best variant without storing any visitor data.

## Docs

Full SDK reference: [sentient-ui.com/docs](https://sentient-ui.com/docs).  
Integrations: [sentient-ui.com/docs/integrations](https://sentient-ui.com/docs/integrations).

## License

MIT
