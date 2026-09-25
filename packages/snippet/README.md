# @sentientui/snippet

[SentientUI](https://sentient-ui.com) for sites that are not built with React (Shopify, Webflow,
WordPress, plain HTML). A script tag: visitor-type attributes on `<html>` plus learned `data-*` style tokens on the
elements you declare. Plain CSS does the rest. No HTML is ever accepted or injected — text is
written as `textContent`, styles come from a bounded validated set, and dashboard-authored
Composition Blocks are a typed, enumerated component tree rendered via `createElement` only
(there is no sanitizer because there is no HTML to sanitize). The structural changes possible
are: moving a declared element among its own siblings (a registry `moveBefore`/`moveAfter` op,
applied after the decision returns; a drifted anchor applies nothing), reordering the sections
you list in `sections` within their shared parent (never applied unless every selector still
resolves and the served order is exactly a permutation of them), and revealing one published
Composition-Block arm inside its slot (all arms render hidden up front; the served one is
shown, and removing the arm restores your original markup exactly). If anything fails, your
page is left exactly as it was.

The install is two tags in `<head>`: an inline tag that sets `window.sentient` and then runs
the pre-paint script, followed by the deferred loader. Copy the real thing from your dashboard's
Install page, or generate it (the pre-paint script is ~2.6 KB and byte-identical for every site,
so it is not reproduced here):

```html
<script>
  window.sentient = {
    apiKey: 'pk_your_key',            // sentient-ui.com → Settings
    personaAttributes: true,          // sets data-sentient-persona / -confidence on <html>
    persona: () => window.myApp?.role, // optional: declare the role your site already knows
                                       // (string or function; must be a key from Settings → Personas)
    sections: ['#hero', '#pricing', '#faq'], // optional: sections eligible for reordering,
                                             // CSS selectors in your theme's natural order
    slots: {
      hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' },
    },
    // registry: true,                // needed alongside `slots` — see the note below
  };
  /* SentientUI pre-paint script goes here, in the same tag, after the `;` */
</script>
<script
  src="https://unpkg.com/@sentientui/snippet/dist/snippet.global.js"
  defer
  crossorigin="anonymous"
></script>
```

> **Declaring `slots` turns off dashboard-published components.** A bare `{ apiKey }`
> install serves the components you publish from the dashboard; as soon as `slots` is
> non-empty, that default flips off. Add `registry: true` to keep both. With
> `debug: true` the snippet logs this when it happens. (`context` is no longer needed —
> the project's type is set in the dashboard; an existing `context` key is ignored.)

**Published components are decided only where they are.** Before deciding, the snippet
fetches the project's published component locators (`GET /v1/registry/locators`, in parallel
with session setup) and resolves them against the page once it has parsed. Only components
whose element is on this page are decided, so a component that lives on `/pricing` gets no
trial — and no dilution of its results — from your home page. For three seconds after the
page loads, and after each client-side navigation, the snippet keeps watching for components
that render late (hydrating frameworks, client routers) and decides them when they appear. If the
locators request fails, that page view shows your original page and records nothing for any
component. A component is reported as "element not found" (which can pause it) only when it
is expected on this page (its page scope, set in the editor, matches) and still missing when that watch ends, or when an
element is there but no longer matches what was saved; being absent from a page it was never
meant for is not a failure.

**The pre-paint script.** The loader above is `defer`, so it runs after your page has parsed —
and on a return visit the browser may already have painted your original section order and
baseline styles before it does. The pre-paint script closes that gap: a tiny synchronous inline
script that applies the last served decision *before* the page paints. It reads only the
snapshot already stored on that visitor's own device, makes no network request, hides nothing
(there is no cloak here, by design), and does nothing at all on a first visit, for a
Do-Not-Track / Global Privacy Control visitor, or unless the config says `consent: true` or
has no consent gate at all. It can't read a consent platform (it runs before any of them load),
so with `consentFrom` it steps aside and the loader applies the visitor's decision once the
platform grants. See [Consent](#consent). Anything it gets wrong — a
selector that resolved differently mid-parse, say — the loader reverts within the same page
load. It reads `window.sentient` when it runs, which is why it can share a tag with the config
(keep the `;` that ends the assignment). Skip it and everything still works; your returning
visitors just see the change land a beat later. Generating the tags yourself:

```js
import { renderSnippetInstall, renderSnippetPrePaintScript } from '@sentientui/snippet/install';

renderSnippetInstall({ config: { apiKey: 'pk_your_key' } });              // two tags (default)
renderSnippetInstall({ config: { apiKey: 'pk_your_key' }, split: true }); // three tags
```

`config` must be JSON values (a `persona` function is dropped — hand-write that key); it is
escaped for inline HTML, so a value containing `</script>` cannot end the tag.

**Strict Content-Security-Policy (script hashes).** Use the three-tag form instead: the config
in its own `<script>`, the pre-paint script alone in a second, then the loader — in that order.
The combined tag contains your config, so its hash is different for every site and changes
whenever the config does; split out, the pre-paint tag is byte-identical everywhere, so one hash
covers it and only the short config tag needs a hash of its own. Installs from before the
two-tag form — three tags, or config + loader with no pre-paint script — keep working unchanged.

The URL above carries no version: unpkg resolves it to the latest release, so your site picks
up new snippet versions on its own and this tag is pasted once. That is the recommended setup,
and what the Shopify app embed and the dashboard's install page both hand out.

**Pinning instead.** Add `@<version>` to the package path
(`@sentientui/snippet@0.21.0/dist/snippet.global.js`) when you want a controlled rollout, or
when you want Subresource Integrity — an SRI hash is only possible on a pinned URL, since the
hash changes with every release. Compute it from the published file
(`openssl dgst -sha384 -binary dist/snippet.global.js | openssl base64 -A`) and pass it as
`integrity="sha384-…"`, or self-host the files and skip the CDN entirely. Do **not** ship a
placeholder `integrity` value — a hash that doesn't match makes the browser refuse to run the
script. A pinned snippet loads its lazy chunks (below) with integrity too: their hashes are
built into each release. A pinned tag is yours to update; the SentientUI dashboard flags the project when the
version it sees running falls behind.

**Lazy chunks.** Four parts load on demand from beside the snippet's own URL:
`engagement.global.js` (section and interaction capture, fetched at boot in parallel with the
decision, only for a visit that may be tracked), `consent.global.js` (only when a consent
source is configured, or on Shopify),
`preview.global.js` (only for `?sentient_preview=` / `?sentient_persona=` links from your
dashboard) and `editor.global.js` (only when you open the on-site editor). Self-hosting? Put
all five files in one folder. If the chunk URL can't be derived (an inlined or bundled
snippet), set `consentSrc` / `editorSrc` in `window.sentient`. A missing consent chunk keeps
tracking **off** and logs a warning.

**Content-Security-Policy nonces.** The snippet's injected `<style>` and chunk `<script>`
elements carry the nonce of a script already on the page, or `nonce` from `window.sentient`,
so a nonce-based policy needs no `'unsafe-inline'`.

```css
#hero[data-tone='urgent'] .cta { font-weight: 700; }
html[data-sentient-persona='trial_user'] .upgrade-banner { display: block; }
```

The first value of each dim is your baseline (what you show today). Decisions are locked per
session and learned per visitor type on the SentientUI API: a first visit sees your original, the return visit adapts.

`persona` declares the visitor type your site already knows (e.g. a role from your own
session state) instead of waiting for it to be inferred. It must be a key in the project's
persona vocabulary (dashboard → Settings → Personas); unrecognized values are ignored
server-side and surfaced in the dashboard so you can add them. Keep it a low-cardinality
role label — never a user id or email.

`sections` lists the page sections the optimizer may reorder, as CSS selectors in the order
your theme renders them (the first learned baseline). Each selector must match exactly one
element and all of them must share one parent; anything else — a missing section, an ambiguous
selector, a served order that isn't a permutation of your list — applies nothing. Return visits
apply the last served order from a local snapshot; with the pre-paint script installed that
happens before the browser paints, so there is no natural-order flash at all.

The snippet also captures per-section attention (visible time + scroll depth) and behavioral
signals by default — that's what builds audience profiles with zero tagging. Add
`sectionCapture: false` to `window.sentient` to turn it off; it never runs for a Do-Not-Track,
Global Privacy Control, or consent-gated visitor.

## Consent

Tracking starts on the first page view unless you gate it. Pick one:

```js
window.sentient = { apiKey: 'pk_…', consentFrom: 'cookiebot' };
// or 'onetrust' | 'cookieyes' | 'tcf' | 'google-consent-mode' | 'shopify',
// { cmp: 'onetrust', group: 'C0004' }, { cmp: 'google-consent-mode', region: 'ES' },
// { cookie: 'my_consent', value: 'yes', event: 'my-consent-changed' }
window.sentient = { apiKey: 'pk_…', consent: false }; // then SentientSnippet.grantConsent()
```

- **Shopify:** set `consentFrom: 'shopify'` (Shopify's Customer Privacy API, which Shopify's
  banner and every Shopify cookie-banner app report into), as the theme embed does. With neither
  `consent` nor `consentFrom` set the snippet picks it too, but the inline pre-paint script
  only steps aside if `window.Shopify` already exists when it runs, so it depends on tag
  placement.
- **Typos fail closed:** an unknown `consentFrom` or a non-boolean `consent` logs a warning and
  keeps tracking **off** until the config is fixed.
- **Grant and revoke without a reload:** the snippet starts tracking when the platform grants,
  and stops and forgets the visitor when it revokes. A refusal given on a page without the
  snippet is acted on at the next page that has it. Once the platform has answered, a return
  to "no answer" (a banner reset that deletes its cookie) pauses tracking and keeps the visitor.
- **A banner that may answer before the snippet loads:** with `consent: false`, call
  through a stub so an early answer is queued and replayed in order once the snippet boots:

  ```js
  (function () {
    var S = (window.SentientSnippet = window.SentientSnippet || { q: [] });
    // Queued before boot; forwarded to the live API after it, so a CMP that
    // saved a method (onAccept = SentientSnippet.grantConsent) still reaches it.
    ['goal', 'grantConsent', 'revokeConsent'].forEach(function (m) {
      S[m] = S[m] || function () {
        var live = window.SentientSnippet;
        if (live !== S && live && live[m]) return live[m].apply(live, arguments);
        S.q.push([m].concat([].slice.call(arguments)));
      };
    });
  })();
  ```

  If the visitor already accepted on an earlier page, pass `consent: true` instead.
- **Your own JS-API banner:** `{ check, event }` sources pause on false; add
  `refused: () => …` so a refusal also deletes the visitor's data.
- **Reusing the reader:** `SentientSnippet.consentWatcher(source)` gates your other
  consent-bound scripts on the same reader. Its `read()` returns `null` until the presets chunk
  has loaded (usually tens of milliseconds), so subscribe instead of reading once at load:
  `w.subscribe(() => w.read() && loadPixel())`.

Everything stored and sent is listed in
[SDK_COOKIE_DISCLOSURE.md](https://github.com/SentientUI/sdk/blob/main/SDK_COOKIE_DISCLOSURE.md).

The always-on bundle is capped at 29 KiB gzip, a ceiling that only ever goes down. The
engagement, consent and preview chunks are capped at 6.5, 3.5 and 3 KiB gzip, the editor overlay
at 30 KiB gzip, and the pre-paint tag at 3 KiB raw. All limits are CI-enforced. MIT.
