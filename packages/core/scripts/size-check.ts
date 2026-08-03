import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '../dist');

// tsup may emit shared chunks; include all of them so the measurement is a
// conservative upper bound on what an application actually downloads.
const chunkFiles = readdirSync(distDir).filter((f) => f.startsWith('chunk-') && f.endsWith('.mjs'));
const chunkBytes = Buffer.concat(chunkFiles.map((f) => readFileSync(join(distDir, f))));

function gzipSize(buffers: Buffer[]): number {
  return gzipSync(Buffer.concat(buffers)).length;
}

/**
 * Bundles are measured as (shared chunk + entry) so the limit reflects what
 * an application actually downloads, not just the re-export stub.
 */
const BUNDLES: { name: string; entry: string; limit: number }[] = [
  {
    name: '@sentientui/core (lean)',
    entry: 'index.mjs',
    // chunk holds the lean core; no scanner or graph code present.
    // raised for keyless local-mode client (engine itself is condition-gated out)
    limit: 10240,
  },
  {
    name: '@sentientui/core/graph (additions only)',
    entry: 'index-graph.mjs',
    // scanner + graph on top of the shared chunk.
    limit: 16384,
  },
];

let failed = false;

for (const bundle of BUNDLES) {
  const entryBytes = readFileSync(join(distDir, bundle.entry));
  const size = gzipSize([chunkBytes, entryBytes]);
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
