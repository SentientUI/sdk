# @sentientui/snippet

Style-rung [SentientUI](https://sentient-ui.com) for sites that are not built with React.
One script tag: visitor-type attributes on `<html>` plus learned `data-*` style tokens on the
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

```html
<script>
  window.sentient = {
    apiKey: 'pk_your_key',            // sentient-ui.com → Settings
    context: 'landing',               // 'landing' | 'ecommerce' | 'saas' | 'marketplace'
    personaAttributes: true,          // sets data-sentient-persona / -confidence on <html>
    persona: () => window.myApp?.role, // optional: declare the role your site already knows
                                       // (string or function; must be a key from Settings → Personas)
    sections: ['#hero', '#pricing', '#faq'], // optional: sections eligible for reordering,
                                             // CSS selectors in your theme's natural order
    slots: {
      hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' },
    },
  };
</script>
<!-- Optional but recommended: the pre-paint tag. Copy the real thing from your
     dashboard's Install page — it is one ~2.6 KB inline script, byte-identical
     for every site, so it is not reproduced here. -->
<script>/* SentientUI pre-paint */</script>
<script
  src="https://unpkg.com/@sentientui/snippet/dist/snippet.global.js"
  defer
  crossorigin="anonymous"
></script>
```

**The pre-paint tag.** The loader above is `defer`, so it runs after your page has parsed —
and on a return visit the browser may already have painted your original section order and
baseline styles before it does. The middle tag closes that gap: a tiny synchronous inline
script that applies the last served decision *before* the page paints. It reads only the
snapshot already stored on that visitor's own device, makes no network request, hides nothing
(there is no cloak here, by design), and does nothing at all on a first visit or for a
Do-Not-Track / Global Privacy Control / consent-gated visitor. Anything it gets wrong — a
selector that resolved differently mid-parse, say — the loader reverts within the same page
load. Skip it and everything still works; your returning visitors just see the change land a
beat later. Generating it yourself:

```js
import { renderSnippetPrePaintScript } from '@sentientui/snippet/install';
```

The URL above carries no version: unpkg resolves it to the latest release, so your site picks
up new snippet versions on its own and this tag is pasted once. That is the recommended setup,
and what the Shopify app embed and the dashboard's install page both hand out.

**Pinning instead.** Add `@<version>` to the package path
(`@sentientui/snippet@0.21.0/dist/snippet.global.js`) when you want a controlled rollout, or
when you want Subresource Integrity — an SRI hash is only possible on a pinned URL, since the
hash changes with every release. Compute it from the published file
(`openssl dgst -sha384 -binary dist/snippet.global.js | openssl base64 -A`) and pass it as
`integrity="sha384-…"`, or self-host the file and skip the CDN entirely. Do **not** ship a
placeholder `integrity` value — a hash that doesn't match makes the browser refuse to run the
script. A pinned tag is yours to update; the SentientUI dashboard flags the project when the
version it sees running falls behind.

```css
#hero[data-tone='urgent'] .cta { font-weight: 700; }
html[data-sentient-persona='deal_seeker'] .discount-banner { display: block; }
```

The first value of each dim is your baseline (what you show today). Decisions are locked per
session and learned per visitor type on the SentientUI API: Visit 1 learns, Visit 2 converts.

`persona` declares the visitor type your site already knows (e.g. a role from your own
session state) instead of waiting for it to be inferred. It must be a key in the project's
persona vocabulary (dashboard → Settings → Personas); unrecognized values are ignored
server-side and surfaced in the dashboard so you can add them. Keep it a low-cardinality
role label — never a user id or email.

`sections` lists the page sections the optimizer may reorder, as CSS selectors in the order
your theme renders them (the first learned baseline). Each selector must match exactly one
element and all of them must share one parent; anything else — a missing section, an ambiguous
selector, a served order that isn't a permutation of your list — applies nothing. Return visits
apply the last served order from a local snapshot; with the pre-paint tag installed that
happens before the browser paints, so there is no natural-order flash at all.

The snippet also captures per-section attention (visible time + scroll depth) and behavioral
signals by default — that's what builds audience profiles with zero tagging. Add
`sectionCapture: false` to `window.sentient` to turn it off; it never runs for a Do-Not-Track,
Global Privacy Control, or consent-gated visitor.

Bundle ≤ 23 KiB gzip, pre-paint tag ≤ 3 KiB raw (both CI-enforced). MIT.
