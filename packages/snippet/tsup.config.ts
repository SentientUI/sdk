import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Read the package version at build time and inject it into the bundle via
// `define` below, so the exported `version` always matches what's published.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig([
  {
    // Two IIFE bundles: the lean always-on snippet, and a separate editor overlay
    // loaded lazily only in ?sentient_editor= mode (zero bytes on the normal path,
    // so it never counts against the snippet's 21 KiB budget). Each bundle has its
    // own gzip budget enforced by scripts/size-check.ts.
    entry: { snippet: 'src/index.ts' },
    format: ['iife'],
    globalName: 'SentientSnippet',
    platform: 'browser',
    target: 'es2017',
    minify: true,
    // Never clean here: the configs build in parallel, and cleaning in one
    // could delete another's freshly written chunk. `pnpm build` clears dist
    // before tsup instead.
    clean: false,
    noExternal: [/@sentientui\/core/],
    define: {
      __SNIPPET_VERSION__: JSON.stringify(pkg.version),
      // Placeholders scripts/stamp-chunk-sri.mjs replaces with the lazy
      // chunks' sha384 once they are built (the editor overlay is built in
      // this same pass, so its hash can't be known here).
      __CONSENT_SRI__: JSON.stringify('__SNT_SRI_CONSENT__'),
      __EDITOR_SRI__: JSON.stringify('__SNT_SRI_EDITOR__'),
      __PREVIEW_SRI__: JSON.stringify('__SNT_SRI_PREVIEW__'),
      __ENGAGEMENT_SRI__: JSON.stringify('__SNT_SRI_ENGAGEMENT__'),
    },
  },
  {
    // Two IIFE bundles: the lean always-on snippet, and a separate editor overlay
    // loaded lazily only in ?sentient_editor= mode (zero bytes on the normal path,
    // so it never counts against the snippet's 21 KiB budget). Each bundle has its
    // own gzip budget enforced by scripts/size-check.ts.
    entry: { editor: 'src/editor/index.ts' },
    format: ['iife'],
    // Its own global: sharing `SentientSnippet` made the editor bundle, on
    // load, overwrite the live page API (SentientSnippet.goal etc.).
    globalName: '__sentientEditorBundle',
    platform: 'browser',
    target: 'es2017',
    minify: true,
    // Never clean here: the configs build in parallel, and cleaning in one
    // could delete another's freshly written chunk. `pnpm build` clears dist
    // before tsup instead.
    clean: false,
    noExternal: [/@sentientui\/core/],
    define: {
      __SNIPPET_VERSION__: JSON.stringify(pkg.version),
      // Placeholders scripts/stamp-chunk-sri.mjs replaces with the lazy
      // chunks' sha384 once they are built (the editor overlay is built in
      // this same pass, so its hash can't be known here).
      __CONSENT_SRI__: JSON.stringify('__SNT_SRI_CONSENT__'),
      __EDITOR_SRI__: JSON.stringify('__SNT_SRI_EDITOR__'),
      __PREVIEW_SRI__: JSON.stringify('__SNT_SRI_PREVIEW__'),
      __ENGAGEMENT_SRI__: JSON.stringify('__SNT_SRI_ENGAGEMENT__'),
    },
  },
  {
    // consent.global.js: the consent-platform presets, fetched by the snippet
    // only when a consent source is configured (src/consent-lazy.ts). Its own
    // config so its IIFE global is __sentientConsent, never SentientSnippet.
    entry: { consent: 'src/consent-entry.ts' },
    format: ['iife'],
    globalName: '__sentientConsent',
    platform: 'browser',
    target: 'es2017',
    minify: true,
    clean: false,
    noExternal: [/@sentientui\/core/],
  },
  {
    // preview.global.js: ?sentient_preview= / ?sentient_persona= QA modes,
    // fetched only when the URL asks for one (src/preview.ts).
    entry: { preview: 'src/preview.ts' },
    format: ['iife'],
    globalName: '__sentientPreview',
    platform: 'browser',
    target: 'es2017',
    minify: true,
    clean: false,
    noExternal: [/@sentientui\/core/],
  },
  {
    // engagement.global.js: section attention + interaction capture, fetched
    // at boot in parallel with the decide (src/engagement-entry.ts).
    entry: { engagement: 'src/engagement-entry.ts' },
    format: ['iife'],
    globalName: '__sentientEngagement',
    platform: 'browser',
    target: 'es2017',
    minify: true,
    clean: false,
    noExternal: [/@sentientui\/core/, /@sentientui\/policy/],
  },
  {
    // `@sentientui/snippet/install`: the tag generators, as an ordinary Node
    // module. Nothing here runs in a browser — it builds the install strings —
    // so the install surfaces (dashboard install page, site check-up prompt,
    // Shopify embed pin test) can import the exact bytes from this package
    // instead of reaching past it into @sentientui/core.
    //
    // Separate config, not a third entry above: this one must be importable
    // (esm + cjs + types), and it must NOT be an IIFE that assigns a global.
    // `clean` stays off so it doesn't wipe the bundles built by the first pass.
    entry: { install: 'src/install.ts' },
    format: ['esm', 'cjs'],
    platform: 'neutral',
    target: 'es2020',
    dts: true,
    clean: false,
  },
]);
