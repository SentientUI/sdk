# @sentientui/react

React SDK for [SentientUI](https://sentient-ui.com) — the adaptive ladder. Declare bounded
variations (styles, content, arrangement order); a persona-keyed optimizer on the hosted API
learns which one converts best for each visitor type, and measures the lift against a held-out control group.

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
# open http://localhost:3000?sentient_persona=a, then ?sentient_persona=b — the example adapts
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

Give `<SentientPersonaScript>` the same consent gate as the provider
(`<SentientPersonaScript apiKey="pk_…" consentFrom="cookiebot" />`). With `consent={false}`, or a
`consentFrom` and no `consent={true}`, it renders nothing, because its fallback reads the decision
stored on the visitor's device, which has to wait for consent. `AdaptiveRoot` does this for you.

## The adaptive ladder

### Rung 0 — Observe

Install is the integration. The dashboard immediately shows who is arriving: persona mix, device
and traffic-source segments, engagement signals. The "Suggested next step" card tells you which
rung to climb next, with a copy-pasteable snippet.

### Rung 1 — Style (CSS only)

**1a. Persona attributes — zero declaration.** The SDK sets on `<html>`:

```
data-sentient-persona   = <vocabulary key> | unknown
data-sentient-confidence = low | medium | high
```

The persona value is a key from the project's persona vocabulary (dashboard → Settings →
Personas) — declared by your app via the `persona` prop, or discovered from behavior. The
vocabulary starts empty (every visitor is `unknown` until a persona exists). Renaming a persona in
the dashboard keeps the old key resolving as an alias, so existing CSS stays intact.

Write plain CSS against them (the canonical block — swap in your own persona keys):

```css
/* Show each visitor type what it cares about. Confidence-gate bold treatments. */
html[data-sentient-persona='admin'] .admin-tools { display: block; }
html[data-sentient-persona='evaluator'] .spec-details { display: block; }
html[data-sentient-confidence='low'] .spec-details { display: none; }
```

In keyless local mode (development without a `pk_` key), force any persona with
`?sentient_persona=evaluator` (any key works locally). The override is not read in hosted (`pk_`) mode.

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

`<Adaptive>` fills a region one of two ways.

**Generated versions (start here).** Wrap what you show today — the children are the original:

```tsx
import { Adaptive } from '@sentientui/react';

<Adaptive id="hero-cta" goal="signup_click">
  <a href="/signup">Start free trial</a>
</Adaptive>
```

Mounting it and deploying registers the region. SentientUI then writes versions per visitor type
in the dashboard ("Who sees what") — no redeploy. The children render for holdout/control
traffic, unknown visitor types, visitor types with no version yet, and every error path, so the
worst case is always "nothing changed". This works in any React app under `<AdaptiveRoot>` or
`<AdaptiveProvider>` as-is — no server preload: the regions mounted on a page are requested in
one batched call scoped to exactly those ids. A first visit shows the original briefly, then
swaps; return visits start from the last version served. Keyless local mode renders the
originals only. (Formerly `<AdaptiveSlot>`.)

**Code variants.** When you want to write the alternatives yourself, pass `variants` instead of
children:

```tsx
<Adaptive
  id="buy-box"
  goal="buy_click"                                                // required
  variants={{ control: <CalmBuyBox />, urgent: <UrgentBuyBox /> }} // first key = baseline
/>
```

Use one or the other on a given `<Adaptive>`, not both. `useAdaptive` is the hook form of code
variants:

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
attach it or the component cannot learn (dev mode warns loudly if you don't). `<AdaptiveText>`
swaps dashboard-managed text.

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
| `components` | `Array<{ id: string; variantIds: string[] }>` *(optional, default `[]`)* | Code-variant components to preload server-side. `id` must match `<Adaptive id="…" variants={…}>`; generated-version `<Adaptive>` regions need no entry. Omit when the tree uses only slots/sections or assigns client-side. |
| `sections` | `string[]` *(optional)* | Page section IDs in default order. When provided, a single `POST /v1/decide` returns both layout order and assignments; `useLayoutOrder()` becomes available. Give each section's element `data-sentient-id="<sectionId>"` — the only attribute a section needs — so the graph scanner can register it; without it the server types the section `generic` and every persona gets the same order. The provider warns about unresolvable ids in development. |
| `registrySlotIds` | `string[]` *(optional)* | The generated-mode `<Adaptive id>`s this page renders. Decides their published versions in the same SSR round trip and serializes the served content into the HTML, so first paint shows the version instead of the original children. Scoped to exactly these ids — an unscoped registry decide would record a trial for every published slot on every page. Omit and the regions decide client-side after mount. |
| `sectionTypes` | `Partial<Record<string, SemanticType>>` *(optional)* | What each section is, keyed by `data-sentient-id`: `{ about: 'trust', contact: 'cta' }`. Sections are classified from their content, so declare only the ones it gets wrong — a band with little signal-bearing copy (an "About us" block, a contact form) reads `generic` and is ordered the same for every persona. Any section with a `data-sentient-id` can appear, reorderable or not. Also accepted by `AdaptiveProvider`. |
| `apiKey` | `string` | `pk_…` key — used by both the browser SDK and server-side SSR requests. |
| `appOrigin` | `string` *(default `http://localhost:3001`)* | Your app origin (e.g. `https://yourapp.com`). Must be on the project's allowed-origins list. Always set in production. |
| `context` | `'landing' \| 'ecommerce' \| 'saas' \| 'marketplace'` *(optional, deprecated)* | Unused — the project's type is set in the dashboard. Safe to omit. |
| `persona` | `string` *(optional)* | Declared persona — the role your app already knows for this visitor (e.g. from your auth context). Must be a key in the project's persona vocabulary (dashboard → Settings → Personas); unrecognized values are ignored server-side. Served at full confidence, overriding the inferred persona; forwarded through both SSR paths. Stable for the session — remount to apply a new value. Never a user id or email. |
| `consent` | `boolean` *(default `true`)* | Set `false` to skip SDK init (no cookies, no events). Flip to `true` after the visitor accepts. |
| `respectDoNotTrack` | `boolean` *(default `true`)* | Honor the browser's Do Not Track signal. When on and DNT is enabled, the SDK sets no cookies and sends no tracking data (overriding `consent: true`), and `grantConsent()` won't re-enable it. Set `false` to make your own consent gate authoritative. |
| `consentFrom` | preset or `{ cookie, value, event }` *(optional)* | Your consent platform — see [Consent management](#consent-management-gdpr). Cookie-based sources are also read on the server, so a consented visitor gets personalized HTML and a non-consented one gets none. |
| `timeoutMs` | `number` *(default `1000`)* | Server-side fetch timeout before falling back to the first variant. Typical decide is well under 150 ms; the full budget is only reached on a cold start or an API distant from your SSR host. |
| `nonce` | `string` *(optional)* | CSP nonce for the inline pre-paint script and the `<style>` the client injects. |
| `debug` | `boolean` | Log assignment and event activity to the console. |

#### What `<AdaptiveRoot>` costs your rendering

- **Every route under it renders dynamically.** It reads `headers()` and `cookies()` to decide per visitor, so
  Next.js can't statically generate or ISR-cache those routes.
- **It adds one API round trip to time-to-first-byte**, usually well under 150 ms and capped by `timeoutMs`
  (default 1000 ms). On timeout the page renders the originals and decides in the browser instead.
- **It skips the round trip entirely** for visitors it must not track (DNT/GPC, consent refused or not yet given).

Want static pages? Put `<AdaptiveProvider>` in a client component instead, only around the routes that adapt.
Decisions then happen in the browser after hydration: the server HTML shows the originals, a returning
visitor's last decision is restored from the SDK's local snapshot as soon as the client starts (no network
wait), and a first-time visitor's arrives after one round trip.

`@sentientui/react/next` is ESM-only (the App Router always loads it as ESM). The package root and
`/server` ship both ESM and CommonJS.

### `<AdaptiveProvider>` (any React app)

Accepts the same `apiKey`, `persona`, `consent`, `debug` props as `<AdaptiveRoot>`, plus `onAssignment` (not available on `<AdaptiveRoot>` — function props can't cross the RSC boundary) and:

| Prop | Type | Description |
|------|------|-------------|
| `initialAssignments` | `Record<string, string>` | SSR-preloaded assignments — the `assignments` field of `loadAdaptiveAssignments`' return value (not the whole object). |
| `ssrSessionId` | `string` | The `sessionId` field of `loadAdaptiveAssignments`' return value. Required with `initialAssignments` so the browser adopts the same session the server assigned — otherwise exposures and goals attach to a different session than the SSR assignment. |
| `sessionSegment` | `string` | Segment from SSR (`device:source`). Must match the value used in `loadAdaptiveAssignments`. |
| `initialLayoutOrder` | `string[] \| null` | Preloaded section order from `loadAdaptiveDecision` (for Pages-Router-style SSR with sections). |

### `<Adaptive>`

One component, two modes — pass `children` (generated versions) or `variants` (code variants),
never both. `AdaptiveProps` is the union of the two exported prop types below.

**Generated versions** — `AdaptiveGeneratedProps`:

| Prop | Type | Description |
|------|------|-------------|
| `id` | `string` | Unique region identifier within your project. |
| `children` | `ReactNode` | The original. Renders for holdout/control traffic, unknown visitor types, visitor types with no version, and every error path. |
| `goal` | `string \| GoalConfig` *(optional)* | Conversion goal credited to this region. |
| `onFormSubmit` | `(values: Record<string, string>) => void` *(optional)* | Receives the values when a generated form version submits. Form versions are only offered when this is present; values never reach SentientUI. |
| `as` | `'div' \| 'section' \| 'li' \| 'span' \| …` *(optional, default `'div'`)* | Wrapper element — e.g. `'li'` inside a list. Always a real element, never `display: contents`: it is what exposure and goals observe. |
| `className` | `string` *(optional)* | Class for the wrapper element. |
| `reportBaselineText` | `boolean` *(default `true`)* | At first registration, send this region's rendered text (capped at 400 chars) so generated versions are grounded in what they replace. Set `false` for a region wrapping personalized or account content. |

**Code variants** — `AdaptiveVariantsProps`:

| Prop | Type | Description |
|------|------|-------------|
| `id` | `string` | Unique component identifier within your project. |
| `variants` | `Record<string, ReactNode>` | Map of variant ID → content. Any two or more keys; the first key is the control, and the bandit explores them all. |
| `goal` | `string \| GoalConfig` | Conversion goal (required). A string is a click-goal label; an object is an explicit `GoalConfig`. |
| `funnel` | `string` *(optional)* | Funnel this component serves — see [Funnels](#funnels--funnel-prop). |
| `microSignalGoals` | `MicroSignalGoals` *(optional)* | When a passive micro-signal fires on this component, also record a named goal: micro-signal type → goal name (or `{ name, weight?, stepIndex? }`), e.g. `{ rage_click: 'confused_by_hero' }`. |
| `agentDataByVariant` | `Record<string, unknown>` *(optional)* | Structured data keyed by variant ID that AI agents can consume via `GET /v1/agent/layout`. Only the assigned variant's entry is sent to the server. Preferred over `agentData`. |
| `agentData` | `unknown` *(optional, deprecated)* | Deprecated in favour of `agentDataByVariant`. Single value stored once regardless of which variant is shown; kept for backward compatibility. |
| `as`, `className` | *(optional)* | Wrapper element and its class, as for generated versions. |
| `clientOnly` | `boolean` | Render nothing on the server; resolve on the client only. Use for cookie-dependent components. Without it, a component with no preloaded assignment server-renders its first variant. (This replaces the deprecated provider-level `ssrFallback="none"`, which is still accepted.) |

#### Which goal API?

One canonical path per situation — the others are for the cases these can't reach:

| You want to record… | Use | Credits |
|---|---|---|
| a click, submit or scroll inside an adaptive region | the `goal` prop on `<Adaptive>` | the version that region showed |
| a visitor reaching a page or route (pricing, checkout) | `usePageGoal(name, { componentId? })` | that component's version, or the session |
| an event you fire yourself, tied to a region (a phone call, a custom widget) | `useAdaptiveGoal(componentId)` | the version that region showed |
| a conversion outside React (server, another framework) | `client.goal(name, { value, externalId })` from `@sentientui/core` | the session |

`useAssignment` records nothing (use `useAdaptive`), and the positional
`client.goal(name, metadata, weight, stepIndex)` form is deprecated in favour of
`client.goal(name, options)`; both leave in 1.0.

#### Goal types

**A string is the goal's NAME; an object config has none.** `goal="signup_click"` reports under
`signup_click` and can be promoted to a primary goal in the dashboard. An object config records
under its bare `type` — `click`, `form_submit`, `scroll_depth` — so every inline click goal on the
project collapses into one row named `click`, and no goal definition is ever created for it.
Prefer a named string; reach for an object only when you need a selector, a threshold or a
composite, and expect the generic name.

```ts
// Any click inside the variant (button, a, role=button). The string is the goal's name.
goal="signup_click"

// Click only on elements matching a CSS selector inside the variant.
// NOTE: unnamed — this reports as "click", not as a goal of your own.
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

#### Funnels — `funnel` prop

Add `funnel="<funnelId>"` to `<Adaptive>`, `useAdaptive`, `useAdaptiveTokens`, or `<AdaptiveGroup>` to declare that the component serves a multi-step funnel (the journey shown on the dashboard's Goals → Funnels tab). The optimizer then scores the component on journey progress: small credit for reaching intermediate steps, full credit at completion (revenue-scaled when the final conversion carries a `value`).

```tsx
// Declares BOTH the funnel's steps and this component's membership —
// a weighted_composite goal + funnel id creates the funnel server-side.
<Adaptive
  id="hero"
  funnel="checkout"
  goal={{
    type: 'weighted_composite',
    steps: [
      { goal: { type: 'scroll_depth', threshold: 0.5 }, name: 'viewed_pricing', weight: 0.2 },
      { goal: { type: 'click' },                         name: 'clicked_cta',   weight: 0.4 },
      { goal: { type: 'form_submit' },                   name: 'signed_up',     weight: 1.0 },
    ],
  }}
  variants={...}
/>

// Membership-only: joins a funnel built in the dashboard or chat.
<Adaptive id="pricing-cta" funnel="checkout" goal="plan_selected" variants={...} />
```

The funnel id is stable — a funnel created in the dashboard or chat is referenced from code with the exact id it shows. Code declarations never overwrite a funnel edited by a human; the dashboard version wins and the component still serves it.

### `<AdaptiveText>`

Lightweight text-only variant (renders an inline `<span>` wrapper by default — change it via the `component` prop). Useful when you publish text variants from the dashboard WYSIWYG. Pass `goal` (a name or a goal config, exactly like `<Adaptive>`) to score the copy — without it the wording is served and logged but never learns.

```tsx
import { AdaptiveText } from '@sentientui/react';

<h1>
  <AdaptiveText id="hero_headline" default="Ship faster with SentientUI" goal="signup_click" />
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
  config: {
    variants: Record<string, T>;         // first key = baseline
    goal: string | GoalConfig;
    funnel?: string;
    microSignalGoals?: MicroSignalGoals; // same mapping as <Adaptive microSignalGoals>
  },
): {
  variant: string;
  value: T;
  bind: { ref: (el: HTMLElement | null) => void; 'data-sentient-id': string; 'data-sentient-variant': string };
  fireGoal: (goalType?: string, opts?: ComponentGoalOptions) => void;
};
```

Headless Swap-rung hook. `goal` is required and `bind` must be attached to a rendered element —
learning needs both. Supersedes `useAssignment`. It runs the same exposure, goal, funnel and
micro-signal tracking as `<Adaptive variants>` (everything waits for the real assignment, not the
first-key placeholder), minus the wrapper `<div>` and the hover `cursor_signal`.

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

The served variant is resolved from the SDK's assignment cache (the same one `<Adaptive id="hero_headline">` populates), so render that component before firing.

`opts.once` records the goal at most once per mounted component, however many times you call it — use it for conversions that are a *state* rather than an action ("reached step 3", an effect that may re-run). Leave it off for genuine repeat actions: each click of "add to cart" is its own conversion.
 `opts` accepts `reward` (0–1, default 1) and `metadata`. This replaces hand-rolled helpers that call `client.track({ eventType: 'goal_achieved', componentId, variantId, … })` — you no longer need to pass or track the variant yourself.

### `usePageGoal(goalName, opts?)`

Records a conversion **once, when a page or route is reached** — the funnel steps that are a destination rather than a click: landing on `/pricing`, reaching a signup form, opening checkout.

```tsx
import { usePageGoal } from '@sentientui/react';

function PricingPage() {
  // Credit reaching this page to whichever hero CTA sent the visitor here.
  usePageGoal('pricing_view', { componentId: 'hero_cta' });
  return <Pricing />;
}
```

Prefer this over a click goal on the link that led here. Arrival survives the navigation, and it also counts visitors who came from the nav, a search result or a shared link — none of whom clicked the CTA you're measuring. Pass `componentId` to credit the variant currently served for it (resolved from the localStorage-backed assignment cache, so it works across the page hop); omit it for a session-level goal with no per-variant attribution. `opts` also accepts `reward` and `metadata`, like `useAdaptiveGoal`.

Two failure modes it exists to prevent, both silent if you hand-roll this with `useAdaptiveGoal` in a `useEffect`:

- **Double counting.** A hand-rolled effect re-runs — React's double-invoked effects in development, or the client arriving — and records the arrival again unless you pass `useAdaptiveGoal`'s `{ once: true }`. Both latches are per mounted component, so a genuine remount records again with either.
- **Losing the goal to a consent gate.** Behind a cookie banner the client doesn't exist when the page mounts, so firing on mount drops the arrival for every visitor who accepts a moment later (and `once` spends its latch on that dropped call). `usePageGoal` holds it until the SDK is running.

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

- captures your page structure and auto-detects what each section is (pricing, hero, social proof, …) — types declared in `sectionTypes` always win over the heuristic;
- records per-section attention (visible time + scroll depth), which is what powers audience profiles with zero tagging.

Both modules are loaded on demand after init, so the base bundle stays lean, and neither ever runs for a Do-Not-Track, Global Privacy Control, or consent-gated visitor (see Consent below).

What they cost, so you can decide: about 21 KB gzip on top of the ~16 KB core client, fetched after hydration (never on the critical path). One `MutationObserver` watches the page for sections added later, and it batches a burst of DOM changes into a single scan 200 ms after the burst starts, so a chat or a live list doesn't make it do work on every frame. Turn graph scanning off and the dashboard's page-structure view goes empty. Turn engagement off and audiences stop learning from on-page behaviour.

Opt out per feature:

```tsx
<AdaptiveProvider apiKey="pk_…" enableGraph={false} engagement={false}>
  <App />
</AdaptiveProvider>
```

Direct `@sentientui/core` users enable graph scanning by importing `init` from `@sentientui/core/graph` with `graph: true`, and engagement capture via `startEngagementCapture` from `@sentientui/core/engagement`.

## Consent management (GDPR)

Tracking starts on first paint unless you gate it — opt-in consent is something you wire up,
not the default (in development the provider warns once when neither `consent` nor
`consentFrom` is set). While the SDK is gated no cookie is written and nothing about the
visitor is sent. The one exception is `preConsentBehavior="statistical_winner"`, which asks
`GET /v1/winner` for the best version, a read-only request that carries no identifier.

A refusal forgets the visitor: the cookie, the assignment cache and the decision snapshot.
That means `consent` flipping to `false`, or the platform recording a "no". A platform that is
still loading, or reopened by a visitor who already said yes, only pauses tracking. Once the
platform has answered in the page load, a return to "no answer" (a banner reset that deletes its
cookie) also pauses: `AdaptiveRoot`'s server-side read applies only until the browser answers.

Conversions fired before consent is known: with `preConsentBehavior` they are held in memory
and sent, in order and ahead of later goals, if the visitor accepts on the same page (dropped on a refusal). Without it there is no
client yet, so `useSentient()` returns `null` and a conversion fired then is not recorded. Use
`usePageGoal`, which waits, or fire once `useSentient()` returns a client.

Every key the SDK stores is listed in
[SDK_COOKIE_DISCLOSURE.md](https://github.com/SentientUI/sdk/blob/main/SDK_COOKIE_DISCLOSURE.md).

### Follow your consent platform (recommended)

Point `consentFrom` at your CMP. The provider reads the platform's own API, events and cookie,
starts the moment it grants, and gates and forgets again on withdrawal — no reload, no callback
wiring:

```tsx
<AdaptiveProvider apiKey={process.env.NEXT_PUBLIC_SENTIENT_API_KEY!} consentFrom="onetrust">
  {children}
</AdaptiveProvider>
```

| Preset | Reads | Default category |
|---|---|---|
| `'cookiebot'` | `Cookiebot.consent`, `CookieConsent` cookie | `statistics` — `{ cmp: 'cookiebot', category: 'marketing' }` to change |
| `'onetrust'` | `OnetrustActiveGroups` (exact group match), `OptanonConsent` cookie | `C0002` — `{ cmp: 'onetrust', group: 'C0004' }` |
| `'cookieyes'` | `getCkyConsent()`, `cookieyes-consent` cookie | `analytics` |
| `'tcf'` | IAB TCF v2.2 `__tcfapi`, `euconsent-v2` cookie | purposes 1, 5, 6, 8 (8 may rest on legitimate interest); `{ cmp: 'tcf', vendorId }` also requires vendor consent |
| `'google-consent-mode'` | the latest `consent default/update` in `dataLayer` | `analytics_storage`; pass `region: 'ES'` (e.g. from your CDN's country header) to resolve region-scoped defaults — without it a region-scoped denial reads as denied |
| `'shopify'` | Shopify Customer Privacy API | `analytics` |

Your own banner works too: `consentFrom={{ cookie: 'analytics_consent', value: 'granted', event: 'consent-decided' }}`,
or any JS API: `consentFrom={{ check: () => window.myCmp?.analytics === true, event: 'mycmp:changed' }}`.
A `check` returning false only pauses tracking; add `refused: () => window.myCmp?.answered === true`
so a refusal also deletes the visitor's data.
Hand-rolled checks are where CMP bugs live (`OnetrustActiveGroups.includes('C0002')` is also
true for `C00021`), so prefer a preset.

To show the best-performing version while the banner is pending, instead of the first one, add
`preConsentBehavior="statistical_winner"` — it calls only `GET /v1/winner`, a read-only endpoint
that stores nothing about the visitor.

### `<AdaptiveRoot>` (Next.js)

`<AdaptiveRoot>` is a Server Component: it takes every preset and the cookie form (a `check`
function cannot cross the server→client boundary). For the cookie-based presets
(`cookiebot`, `onetrust`, `cookieyes`, `tcf`) and the cookie form it also reads the decision on
the server, so an already-consented visitor gets personalized server HTML:

```tsx
<AdaptiveRoot apiKey={process.env.NEXT_PUBLIC_SENTIENT_API_KEY!} consentFrom="cookiebot">
  {children}
</AdaptiveRoot>
```

### Your own flag

```tsx
<AdaptiveProvider apiKey={process.env.NEXT_PUBLIC_SENTIENT_API_KEY!} consent={hasConsent}>
```

Flip `hasConsent` to `true` on accept and back to `false` on withdrawal. Don't wire a CMP
callback to `grantConsent()` in React: with `consent={false}` and no `preConsentBehavior` the
provider has no client to upgrade.

### Without React

```ts
import { init, grantConsent } from '@sentientui/core';

const client = init({ apiKey: 'pk_...', consent: false });
grantConsent();     // on accept: upgrades the client in place
client.destroy();   // on withdrawal: forgets the visitor
```

## Docs

Full SDK reference: [sentient-ui.com/docs](https://sentient-ui.com/docs).  
Integrations: [sentient-ui.com/docs/integrations](https://sentient-ui.com/docs/integrations).

## License

MIT
