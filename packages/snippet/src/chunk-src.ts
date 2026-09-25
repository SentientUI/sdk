import { applyNonce } from '@sentientui/core';
// Where the snippet's lazy chunks (consent presets, editor overlay) load from,
// and the integrity they load with.

declare const __CONSENT_SRI__: string;
declare const __EDITOR_SRI__: string;
declare const __PREVIEW_SRI__: string;
declare const __ENGAGEMENT_SRI__: string;

// Anchored to a path segment and the end of the filename: a bare substring
// match hijacked any site script whose name merely CONTAINED the token
// (e.g. /js/carousel-snippet.js), deriving a bogus chunk URL (audit SNIP-16).
const SELF = /(^|\/)snippet(\.global)?(\.min)?\.js(\?|$)/;
// The script that is running this bundle, read while it evaluates (the only
// moment `currentScript` points at it). Covers a renamed or self-hosted copy
// the filename match can't recognise (review M1: `/assets/sentient.3f2a.js`
// left the consent chunk unresolvable, so the gate never opened).
const BOOT_SRC = ((): string => {
  try {
    return (document.currentScript as HTMLScriptElement | null)?.src ?? '';
  } catch {
    return '';
  }
})();
// A CDN URL pinned to one exact release (unpkg, jsDelivr: `…/pkg@1.2.3/…`).
const PINNED = /@\d+\.\d+\.\d+[^/]*\//;

/** The chunk's URL beside the snippet's own <script src>, or null when the
 *  snippet was inlined or renamed. With `integrity` when the snippet itself is
 *  version-pinned (audit S4): a site that pins the loader with SRI trusts the
 *  CDN for nothing, and before this the chunks it fetched later carried no
 *  integrity at all. An unpinned ("latest") URL gets none — the chunk could be
 *  a newer release than the hash stamped into this build. */
type ChunkFile = 'consent.global.js' | 'editor.global.js' | 'preview.global.js' | 'engagement.global.js';

export function chunkSrc(file: ChunkFile): { src: string; integrity?: string } | null {
  try {
    // The script that booted this bundle first: scanning the page for any
    // `snippet.js` picked up other vendors' loaders (Zendesk's is
    // static.zdassets.com/ekr/snippet.js) and fetched the chunk from THEIR
    // host — a 404, so the consent gate never opened (review M1). The scan
    // is the fallback for when currentScript was unavailable.
    const base = BOOT_SRC || Array.from(document.getElementsByTagName('script')).find((s) => SELF.test(s.src))?.src;
    for (const b of base ? [base] : []) {
      const src = SELF.test(b) ? b.replace(SELF, `$1${file}$4`) : b.replace(/[^/?#]*([?#].*)?$/, file);
      const hash =
        (file === 'consent.global.js'
          ? typeof __CONSENT_SRI__ === 'string' && __CONSENT_SRI__
          : file === 'editor.global.js'
            ? typeof __EDITOR_SRI__ === 'string' && __EDITOR_SRI__
            : file === 'preview.global.js'
              ? typeof __PREVIEW_SRI__ === 'string' && __PREVIEW_SRI__
              : typeof __ENGAGEMENT_SRI__ === 'string' && __ENGAGEMENT_SRI__) || '';
      // Unstamped (a dev build, or the post-build step didn't run): a wrong
      // hash would make the browser refuse the chunk, so send none.
      return PINNED.test(src) && hash.indexOf('sha384-') === 0 ? { src, integrity: hash } : { src };
    }
  } catch {
    /* fail-safe */
  }
  return null;
}

const loading = new Map<string, Promise<unknown>>();

/** Load a lazy chunk once and resolve its IIFE global — null when its URL
 *  can't be derived or it fails to load (a later call retries). */
export function loadChunk<T>(file: ChunkFile, global: string, src?: string): Promise<T | null> {
  const ready = (window as unknown as Record<string, T | undefined>)[global];
  if (ready) return Promise.resolve(ready);
  let p = loading.get(file) as Promise<T | null> | undefined;
  if (!p) {
    p = new Promise<T | null>((resolve) => {
      const chunk = src ? { src } : chunkSrc(file);
      if (!chunk) return resolve(null);
      const el = applyNonce(document.createElement('script'));
      setChunkSrc(el, chunk);
      el.async = true;
      el.onload = () => {
        const g = (window as unknown as Record<string, T | undefined>)[global] ?? null;
        // Loaded but never registered (a version-skewed "latest" chunk): let a
        // later call retry rather than caching the miss for good (review #7).
        if (!g) loading.delete(file);
        resolve(g);
      };
      el.onerror = () => {
        loading.delete(file);
        resolve(null);
      };
      (document.head ?? document.documentElement).appendChild(el);
    });
    loading.set(file, p);
  }
  return p;
}

/** @internal tests */
export function _resetChunks(): void {
  loading.clear();
}

/** Point `el` at a chunk, with integrity + CORS mode when there is a hash. */
export function setChunkSrc(el: HTMLScriptElement, chunk: { src: string; integrity?: string }): void {
  if (chunk.integrity) {
    el.integrity = chunk.integrity;
    el.crossOrigin = 'anonymous';
  }
  el.src = chunk.src;
}
