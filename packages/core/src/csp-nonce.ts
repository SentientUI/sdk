// CSP nonce for the <style> elements the SDKs inject (audit S20: they needed
// `style-src 'unsafe-inline'`, so a site with a strict CSP either weakened it
// or silently lost the reveal animation and every ops style).
//
// Resolution: an explicit nonce (`setCspNonce`, fed by the React provider's
// `nonce` prop or the snippet's `nonce` config) → else the nonce of a script
// already on the page. Browsers hide the nonce ATTRIBUTE from the DOM after
// parse but keep the `.nonce` property, which is what we read — the same
// trick the Next.js/emotion ecosystem uses.

let explicit: string | undefined;

export function setCspNonce(nonce: string | undefined): void {
  explicit = typeof nonce === 'string' && nonce !== '' ? nonce : undefined;
}

export function cspNonce(doc: Document = document): string | undefined {
  if (explicit) return explicit;
  try {
    const el = doc.querySelector('script[nonce]') as HTMLScriptElement | null;
    const n = el?.nonce || el?.getAttribute('nonce');
    return n || undefined;
  } catch {
    return undefined;
  }
}

/** Stamp `el` with the page's nonce when there is one. */
export function applyNonce<T extends HTMLElement>(el: T, doc: Document = document): T {
  const n = cspNonce(doc);
  if (n) el.setAttribute('nonce', n);
  return el;
}
