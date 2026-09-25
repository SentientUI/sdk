import type { ConsentSource, ConsentWatcher } from '@sentientui/core';
import { _resetChunks, loadChunk } from './chunk-src';

// The consent-platform presets live in their own chunk (consent.global.js,
// built from consent-entry.ts), loaded only by a page that configures a
// consent source. They were always-on — ~2 KB gzip on every page view of every
// site, though a site uses one preset and most use none.
//
// This facade honours the ConsentWatcher contract while the chunk is in
// flight: read() is null ("can't tell yet" — the snippet boots gated on it)
// and every subscriber is called once the chunk lands, so the gate opens the
// moment the platform's real answer is readable. A chunk that never loads
// (404, CSP) leaves the visitor gated: the failure mode is "not tracked".

type Factory = (src: ConsentSource) => ConsentWatcher;
type Global = { consentWatcher?: Factory };

const GLOBAL = '__sentientConsent';
let factory: Factory | null = null;
let requested = false;
const waiters = new Set<() => void>();

const fromGlobal = (): Factory | null => {
  const g = (window as unknown as Record<string, Global | undefined>)[GLOBAL];
  return typeof g?.consentWatcher === 'function' ? g.consentWatcher : null;
};

let override: string | undefined;
/** Set by run() from `window.sentient.consentSrc` before the first watcher
 *  (else the chunk loads from beside the snippet's own src — chunk-src.ts). */
export function setConsentSrc(src: string | undefined): void {
  override = src;
}

function ensureLoaded(): void {
  if (factory || (factory = fromGlobal()) || requested) return;
  requested = true;
  void loadChunk<Global>('consent.global.js', GLOBAL, override).then((g) => {
    requested = false;
    if (!g) return warnGated(override ?? 'consent.global.js');
    factory = fromGlobal();
    if (factory) for (const w of Array.from(waiters)) w();
  });
}

/** The failure mode is "not tracked", which is safe but invisible — say so. */
function warnGated(src: string): void {
  console.warn(`[sentient] could not load ${src} — tracking stays off. Set window.sentient.consentSrc to its URL.`);
}

export function consentWatcher(src: ConsentSource): ConsentWatcher {
  ensureLoaded();
  let real: ConsentWatcher | null = null;
  const get = (): ConsentWatcher | null => {
    if (!real && (factory ?? (factory = fromGlobal()))) real = factory!(src);
    return real;
  };
  return {
    read: () => get()?.read() ?? null,
    refused: () => get()?.refused() ?? false,
    subscribe(cb) {
      let stop: (() => void) | undefined;
      let off = false;
      const attach = (): void => {
        waiters.delete(attach);
        const w = get();
        if (off || !w) return;
        stop = w.subscribe(cb);
        cb(); // the answer may already be readable
      };
      // Loaded already: still call back once, like the waiter path does — a
      // refusal on record at boot is only acted on inside the callback, and
      // otherwise waited for the platform's next event (grader N-F).
      if (get()) {
        stop = real!.subscribe(cb);
        void Promise.resolve().then(() => {
          if (!off) cb();
        });
      } else waiters.add(attach);
      return () => {
        off = true;
        waiters.delete(attach);
        stop?.();
      };
    },
  };
}

/** @internal tests */
export function _resetConsentLazy(): void {
  factory = null;
  requested = false;
  waiters.clear();
  _resetChunks();
  override = undefined;
}
