/**
 * `@sentientui/snippet/install` — the tag generators, importable from Node.
 *
 * The package's main entry is a browser IIFE bundle that runs on load, so it can
 * never be imported by tooling. This entry exists so the install surfaces that
 * EMIT the tags (the dashboard's install page, the site check-up prompt, the
 * Shopify theme-embed pin test) can get the exact bytes from the snippet package
 * itself instead of reaching past it into @sentientui/core.
 *
 * Node-safe by construction: it only builds strings.
 */
export { renderSnippetPrePaintScript, SNIPPET_PREPAINT_VERSION } from './prepaint-script';
export type { PrePaintRecord } from './prepaint-script';
