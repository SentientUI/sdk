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
    limit: 15_360, // 15 KB — larger than core due to React bindings
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
    limit: 3_584,
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
