import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '../dist');

/**
 * Each published export entry is gated independently — react externalizes core
 * and emits no shared chunks, so an entry's gzip size is what an app downloads
 * for that import path. Limits are set a little above current size; growth in
 * `./server` or `./next` now trips CI instead of slipping through unmeasured.
 */
const BUNDLES: { name: string; entry: string; limit: number }[] = [
  {
    name: '@sentientui/react',
    entry: 'index.mjs',
    // 15 KB — larger than core due to React bindings.
    // +2048 (2026-09-23, native generation phase 1, spec 2026-09-23 §4.5):
    // Rewrite arms applied over the element tree — `applyEdits` (per-node
    // text, class swap, hide, reorder), the element-tree ↔ DOM parity check
    // that makes a skeleton addressable, the tree fingerprint the decide's
    // `render` caps carry, and the AdaptiveSlot wiring (caps, capture, drift).
    // Must run in render so SSR and hydration agree — not lazy-loadable. The
    // DOM capture itself stays external in @sentientui/core/region. Measured
    // 14940 at HEAD → 16893.
    // +512 (2026-09-23, native generation phase 3; operator: "i dont mind
    // pushing the size"): the hybrid <Adaptive> — variants + children routed
    // onto the slot path, authored arms rendered in place (SSR included), the
    // blocked-until-migrated guard, and authored-arm reporting. Must render
    // in the first pass for SSR parity. Measured 17731.
    // +512 (2026-09-23, native generation phase 2; same operator OK): `like`
    // in the block renderer (a node borrowing the site's own class list keeps
    // only layout styles), renderCompose with its surface, compose precedence
    // in AdaptiveSlot and the vocabulary plumbing. Render-path code, so it
    // must be in the SSR pass. The editor-only sampler stays on its own
    // lazily-imported subpath. Measured 18231.
    // +512 (2026-09-24, same operator OK): a borrowed site style whose class
    // list doesn't set its text colour now carries the colour it was sampled
    // with (inheritsColor), applied at render — the Bodyshop glass button
    // rendered black-on-slate without it. Render path, so it must be in the
    // SSR pass. Measured 18459.
    // +512 (2026-09-25, SDK audit batch): measured 19299 against 18910 at
    // HEAD. What paid for it: consent withdrawal forgetting the visitor under
    // preConsentBehavior and engagement gated on a tracking client (P0-4/5),
    // the no-consent-gate dev warning (S6), the late-swap deadline (S9), block
    // URL scheme checks (S14), CSP nonce (S20) and the `as` wrapper (S17).
    // +256 (same day, SDK regrades 5-6): held conversions handed from the
    // gated client to the tracking one and dropped on a refusal (F2/F-R1).
    // Measured 19477.
    limit: 19_712,
  },
  {
    name: '@sentientui/react/server',
    entry: 'server.mjs',
    limit: 2_048,
  },
  {
    name: '@sentientui/react/next',
    entry: 'next/adaptive-root.js',
    // 3.5 KB — bumped from 3.25 KB (itself bumped from 3 KB for the DNT/Sec-GPC
    // SSR opt-out) for the consent gate: AdaptiveRoot now skips the SSR
    // decide/session when consent is withheld, and resolves a cookie-based
    // `consentFrom` from the request so apps don't read the cookie themselves.
    // Worth ~70 bytes gzip; trimming the implementation recovered only 4, so
    // this is a deliberate rebaseline, not a leak. Keeps the "a little above
    // current size" headroom so real growth still trips CI.
    // +512 (2026-09-24, same operator OK): AdaptiveRoot forwards the server
    // decision's site styles (initialVocabulary). Without them an approved
    // redesign rendered live on Bodyshop with no site classes. Measured 3608.
    limit: 4_096,
  },
];

let failed = false;

for (const bundle of BUNDLES) {
  const size = gzipSync(readFileSync(join(distDir, bundle.entry))).length;
  const ok = size <= bundle.limit;
  const status = ok ? 'ok  ' : 'FAIL';
  const msg = `${status}  ${bundle.name}: ${size} bytes gzip (limit: ${bundle.limit})`;
  if (ok) {
    console.log(msg);
  } else {
    console.error(`${msg}  — over by ${size - bundle.limit} bytes`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
