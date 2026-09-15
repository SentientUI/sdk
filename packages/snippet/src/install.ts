/**
 * `@sentientui/snippet/install` — the tag generators, importable from Node.
 *
 * The package's main entry is a browser IIFE bundle that runs on load, so it can
 * never be imported by tooling. This entry exists so the install surfaces that
 * EMIT the tags (the dashboard's install page, the site check-up prompt, the
 * Shopify theme-embed pin test) can get the exact bytes from the snippet package
 * itself instead of reaching past it into @sentientui/core.
 *
 * Node-safe by construction: it only builds strings. Nothing here is imported by
 * src/index.ts, so none of it rides the always-on bundle.
 */
import { renderSnippetPrePaintScript } from './prepaint-script';

export { renderSnippetPrePaintScript, SNIPPET_PREPAINT_VERSION } from './prepaint-script';
export type { PrePaintRecord } from './prepaint-script';

/** The self-updating loader URL (no version: unpkg resolves it to the latest
 *  release). The same URL the dashboard and the Shopify theme embed hand out. */
export const SNIPPET_LOADER_URL = 'https://unpkg.com/@sentientui/snippet/dist/snippet.global.js';

/**
 * Serialize a `window.sentient` config for an inline `<script>`.
 *
 * JSON.stringify alone is NOT safe to inline: a config string containing
 * `</script>` ends the tag and turns the rest into markup (an injection point for
 * anything a merchant copies from somewhere else), `<!--` flips the parser into
 * the script-data-escaped state where a later `<script` swallows the real close
 * tag, and U+2028/U+2029 are legal in JSON but were line terminators in pre-ES2019
 * JS, so an old engine throws on the whole tag. Escaping EVERY `<` (not just
 * `</script`) covers both parser states at once; `\u003c` decodes back to the
 * same string, so the config the snippet reads is unchanged.
 *
 * JSON values only: a function (e.g. a `persona` resolver) is dropped by
 * JSON.stringify. Hand-write that key into the tag instead.
 */
export function serializeSnippetConfig(config: Record<string, unknown>): string {
  return JSON.stringify(config)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export type SnippetInstallOptions = {
  /** The `window.sentient` config — at minimum `{ apiKey }`. JSON values only. */
  config: Record<string, unknown>;
  /** Loader URL; defaults to the self-updating {@link SNIPPET_LOADER_URL}. Pass a
   *  version-pinned URL for a controlled rollout. */
  loaderSrc?: string;
  /**
   * `false` (default): two tags — the config assignment folded into the start of
   * the inline pre-paint tag, then the loader.
   * `true`: the three-tag form — config, pre-paint, loader. Use it under a
   * hash-based Content-Security-Policy: the combined tag's contents embed the
   * site's own config, so its hash differs per site (and changes whenever the
   * config does), while the split pre-paint tag is byte-identical everywhere and
   * one published hash covers every install.
   */
  split?: boolean;
};

/**
 * The no-code install, as the exact HTML to paste into `<head>`.
 *
 * Folding the config into the pre-paint tag is safe because the pre-paint script
 * reads `window.sentient` when it RUNS, not when it is built (it is a constant
 * with no interpolation), so an assignment earlier in the same tag is visible to
 * it. The `;` after the assignment is load-bearing: the script opens with `(`, so
 * without it the object literal would be CALLED with the IIFE as its argument
 * and the whole tag would throw. The bundle's install-health report is
 * unaffected — it keys on `window.__sntPP`, which the script sets regardless of
 * which tag it ran in, so a two-tag combined install still reports `pp: 1`.
 */
export function renderSnippetInstall(opts: SnippetInstallOptions): string {
  const config = `window.sentient = ${serializeSnippetConfig(opts.config)};`;
  const loader = `<script src="${escapeAttr(opts.loaderSrc ?? SNIPPET_LOADER_URL)}" crossorigin="anonymous" defer></script>`;
  const prePaint = renderSnippetPrePaintScript();
  if (opts.split) {
    return [`<script>${config}</script>`, `<script>${prePaint}</script>`, loader].join('\n');
  }
  return [`<script>${config}\n${prePaint}</script>`, loader].join('\n');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
