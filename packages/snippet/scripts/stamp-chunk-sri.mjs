// Post-build: stamp the lazy chunks' Subresource Integrity hashes into the
// always-on bundle (audit S4). A site that pins the snippet with an SRI hash
// trusts the CDN for nothing — except the chunks the snippet fetches later
// (consent presets, editor overlay), which it loaded with no integrity at all.
// The hashes can only be known after the chunks are built, so tsup leaves a
// placeholder (see `define` in tsup.config.ts) and this replaces it.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = (f) => fileURLToPath(new URL(`../dist/${f}`, import.meta.url));
const sri = (f) => `sha384-${createHash('sha384').update(readFileSync(dist(f))).digest('base64')}`;

const file = dist('snippet.global.js');
let src = readFileSync(file, 'utf8');
for (const [placeholder, chunk] of [
  ['__SNT_SRI_CONSENT__', 'consent.global.js'],
  ['__SNT_SRI_EDITOR__', 'editor.global.js'],
  ['__SNT_SRI_PREVIEW__', 'preview.global.js'],
  ['__SNT_SRI_ENGAGEMENT__', 'engagement.global.js'],
]) {
  if (!src.includes(placeholder)) throw new Error(`stamp-chunk-sri: ${placeholder} not found in snippet.global.js`);
  src = src.split(placeholder).join(sri(chunk));
}
writeFileSync(file, src);
console.log('stamped chunk SRI into snippet.global.js');
