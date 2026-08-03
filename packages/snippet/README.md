# @sentientui/snippet

Style-rung [SentientUI](https://sentient-ui.com) for sites that are not built with React.
One script tag: visitor-type attributes on `<html>` plus learned `data-*` style tokens on the
elements you declare. Plain CSS does the rest. No DOM reordering, ever; if anything fails, your
page is left exactly as it was.

```html
<script>
  window.sentient = {
    apiKey: 'pk_your_key',            // sentient-ui.com → Settings
    context: 'landing',               // 'landing' | 'ecommerce' | 'saas' | 'marketplace'
    personaAttributes: true,          // sets data-sentient-persona / -confidence on <html>
    slots: {
      hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' },
    },
  };
</script>
<script
  src="https://unpkg.com/@sentientui/snippet@0.11.4/dist/snippet.global.js"
  defer
  crossorigin="anonymous"
></script>
```

The version above is pinned to the current published release. To lock the file down, add your
own Subresource Integrity hash computed from the published file
(`openssl dgst -sha384 -binary dist/snippet.global.js | openssl base64 -A`) as an `integrity="sha384-…"`
attribute, or self-host the file and skip the CDN entirely. Do **not** ship a placeholder
`integrity` value — a hash that doesn't match makes the browser refuse to run the script.

```css
#hero[data-tone='urgent'] .cta { font-weight: 700; }
html[data-sentient-persona='deal_seeker'] .discount-banner { display: block; }
```

The first value of each dim is your baseline (what you show today). Decisions are locked per
session and learned per visitor type on the SentientUI API: Visit 1 learns, Visit 2 converts.

The snippet also captures per-section attention (visible time + scroll depth) and behavioral
signals by default — that's what builds audience profiles with zero tagging. Add
`sectionCapture: false` to `window.sentient` to turn it off; it never runs for a Do-Not-Track,
Global Privacy Control, or consent-gated visitor.

Bundle ≤ 15 KB gzip. MIT.
