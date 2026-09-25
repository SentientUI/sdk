# SentientUI SDK — Cookie & Storage Disclosure

**Last updated:** September 25, 2026 · describes the releases after
`@sentientui/core` 0.35, `@sentientui/react` 0.36 and `@sentientui/snippet` 0.31
(earlier releases used `SameSite=Strict`, had no `Secure` flag and kept the
consent presets in the main bundle)

This is what the SentientUI SDKs store in a visitor's browser, when, and for
how long, so you can list it in your cookie notice. A test
(`packages/core/src/cookie-disclosure.test.ts`) scans the SDK source for every
storage key it uses and fails CI if one is missing here.

**None of it is "strictly necessary".** SentientUI personalizes and measures
content. Under the ePrivacy Directive, UK PECR and similar laws, that needs the
visitor's consent before anything below is written. Gate the SDK on your
consent banner (see [Consent](#consent)). Nothing is written while the SDK is
gated.

`<key>` below means the first 12 characters of your publishable key (for
example `pk_live_abcd`). Keys are namespaced per project so two SentientUI
projects on one domain never share a visitor.

## Cookie

| Name | Purpose | Duration | Attributes |
|---|---|---|---|
| `_snt_uid_<key>` | Pseudonymous visitor ID (random UUID), so decisions and conversions from one browser join up across visits | 365 days | First-party, `SameSite=Lax` (sent on a top-level navigation into your site, never on another site's subresource or POST requests), `Path=/`, `Secure` on https pages, set from JavaScript (not `HttpOnly`) |
| `_snt_uid_<key>_probe` | The value `1`, written once to test whether cookies can be stored at all | 1 second | Same |

Older installs used the bare name `_snt_uid`. The SDK still **reads** it so an
existing visitor keeps their ID. Forget-me leaves that shared name in place
(another SentientUI project on the domain may own it) and stops reading it for
this project.

The SDK sets **no third-party cookies**, and the ID is never shared with other
sites or used for advertising.

## localStorage

| Key | Purpose | Lifetime |
|---|---|---|
| `_snt_uid_<key>` | Copy of the visitor ID, for browsers that block the cookie | Until forget-me or site data is cleared |
| `_snt_snap:<full pk_ key>` | Last decision for this visitor (which variants and layout), so the next page can show it before first paint with no flicker | Ignored after 30 days, replaced on every visit |
| `_snt_asgn_<key>_*` | Recent variant assignments, one entry per component | 30 minutes, or the server's TTL |
| `_snt_retry_<key>` | Events that failed to send (offline, server busy), retried on the next page | Until delivered, capped in size |
| `_snt_goal_retry_<key>` | Conversions that failed to send, same retry | Until delivered, capped in size |
| `_snt_graph_nodes_<key>` | Section structure of pages already scanned (tag, type, position — **no text**, unless you turn on `captureDomText`) | Until site data is cleared |
| `_snt_uid_tomb_<key>` | The value `1`, written BY forget-me — only when an older install left a shared `_snt_uid` — so this project doesn't re-adopt it. Identifies no one | Until site data is cleared |
| `_snt_graph_edges` | Legacy: written by builds before 2026. Current SDKs only delete it | — |

The graph cache is written by the React SDK by default (`enableGraph`, on unless
set to `false`) and by `init` from `@sentientui/core/graph`. The snippet does not
write it.

## sessionStorage (cleared when the tab closes)

| Key | Purpose | Written by |
|---|---|---|
| `_snt_uid_<key>` | Copy of the visitor ID when localStorage is unavailable | Core |
| `_snt_fired_goals_<key>` | Which one-per-visit goals already fired, so a reload doesn't count them twice | Snippet |
| `__snt_editor_token` | Session token for the on-site editor | Only when **you** open your own site from the dashboard editor. Never set for visitors |

## What is sent to SentientUI

When tracking is allowed, the SDK sends the visitor ID above, the page path,
referrer, UTM parameters, device class, the versions shown, per-section dwell
and scroll, the conversions you define, and per-visit interaction statistics
(counts and timing of pointer, scroll and key events, and whether graphics are
hardware- or software-rendered — used to tell people from bots). It never sends
what was typed, form contents, or page text; page text is included only if you
turn on `captureDomText`. Retention and sub-processors are in the
[Privacy Policy](https://sentient-ui.com/privacy) and the
[DPA](https://sentient-ui.com/dpa).

## Consent

Tracking is on unless you gate it. Choose one:

**Follow your consent platform (recommended).** The SDK reads the platform's
own API and cookie, starts when it grants, and stops and forgets when it
revokes, with no reload:

```tsx
<AdaptiveProvider apiKey="pk_…" consentFrom="cookiebot">   {/* React */}
```
```html
<script>window.sentient = { apiKey: 'pk_…', consentFrom: 'onetrust' };</script>  <!-- snippet -->
```

Presets: `cookiebot`, `onetrust`, `cookieyes`, `tcf` (IAB TCF v2.2; purposes 1,
5, 6 and 8 by default), `google-consent-mode` (pass `region` to resolve
region-scoped defaults), `shopify` (Customer Privacy API). You can also pass
`{ cookie, value, event }` or `{ check, event }` for your own banner. A `check`
source only pauses tracking when it returns false, because a predicate can't
tell "refused" from "not answered yet". Add `refused: () => …` to have a refusal
delete the visitor's data too.

**On Shopify** the snippet uses Shopify's Customer Privacy API automatically,
unless you set `consent` or `consentFrom` yourself. Shopify's banner and every
Shopify cookie-banner app report into it, and it already applies your region
settings.

**Drive it yourself.** Start gated, then open the gate when the visitor accepts:

```js
window.sentient = { apiKey: 'pk_…', consent: false };  // snippet
SentientSnippet.grantConsent();   // on accept — no reload needed
SentientSnippet.revokeConsent();  // on withdrawal — deletes everything above
```
```tsx
<AdaptiveProvider apiKey="pk_…" consent={accepted}>  {/* React: flip the prop */}
```
```js
import { init, grantConsent } from '@sentientui/core';  // core
const client = init({ apiKey: 'pk_…', consent: false });
grantConsent();      // on accept
client.destroy();    // on withdrawal — deletes everything above
// A destroyed client stays stopped: if the visitor accepts again later,
// init({ apiKey: 'pk_…', consent: false }) again, then grantConsent().
```

While gated, the SDK writes nothing and sends nothing about the visitor: no
identifier, no events. It may make requests that carry only your publishable key
and the page's origin. The snippet loads its own script files (the consent
presets, from beside the snippet) and asks which of your published components
exist (`GET /v1/registry/locators`). With `preConsentBehavior: 'statistical_winner'`
it also asks, once per component, for the best-performing version (`GET /v1/winner`).

**Withdrawal deletes.** Revoking (`consent` flips to `false`, `revokeConsent()`,
`destroy()`, or the platform says no) deletes the cookie and every key above
except the `_tomb` marker it writes, so the next visit starts as a new visitor.
That includes a "no" given on a page without the SDK (a CMP settings page,
checkout): the next page that loads the SDK reads the refusal and deletes
everything. Only a recorded refusal does this. A consent platform that is
still loading, or whose banner is showing, only keeps tracking off. With TCF
only a refusal of purpose 1 (storage) is a recorded "no"; a missing profiling
purpose, or any answer under `purposeOneTreatment`, only keeps tracking off.

Nothing reads the stored decision before consent is known. The snippet, its
inline pre-paint script and the React SDK's `SentientPersonaScript` read it
only for `consent: true` or an install with no consent gate at all. Core's
`renderPrePaintScript()` helper checks only DNT/GPC and the 30-day limit, so a
core install renders it only once consent is known (its README says so). They never read it with `consentFrom`, with
`consent: false`, or on a Shopify storefront (where the snippet follows
Shopify's Customer Privacy API), and a refusal deletes it. It is also ignored
after 30 days everywhere. Two cases still read it until updated: an inline
pre-paint tag pasted before this release (copy the install tag again from the
dashboard), and the Shopify app's theme embed until its next release.

## Do Not Track and Global Privacy Control

If the browser sends DNT or GPC, the SDK behaves as if consent were refused,
even with `consent: true`, and `grantConsent()` can't override it. Pass
`respectDoNotTrack: false` only if your own consent gate is the authority.

## Sample cookie-notice entry

> **SentientUI** (personalization and measurement): sets `_snt_uid_…` (365
> days) and stores related data in your browser's local storage, to show you
> the version of this site that works best and measure which version performs
> better. Set only with your consent. Not used for advertising and not shared
> with other sites.

---

This is a technical disclosure, not legal advice. Consult counsel for your
jurisdiction.
