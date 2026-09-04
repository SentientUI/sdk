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
    // 11 KiB (was 10): the durable goal queue in 6cfe1c2 (durable.ts +
    // goal-queue.ts — localStorage-backed retry so a conversion survives a page
    // unload) added 757 gzip bytes, against 12 bytes of remaining headroom. The
    // weight buys an at-least-once delivery guarantee for revenue events, so it
    // stays; the budget moves one step and no further. Measured 10985.
    //
    // 12 KiB (was 11): page-journey capture (migration 108) — `path` on every
    // event plus the pushState/replaceState/popstate watcher that emits a
    // pageview per route change. 287 gzip bytes against 8 bytes of headroom, and
    // it was already trimmed once (inlined the componentId sentinel, folded the
    // two history patches into a loop) to get there. Before this, NO table
    // recorded which page a visit was on, so "where do visits end" was
    // unanswerable — the bytes buy a capability that did not exist rather than a
    // refinement of one that did. Budget moves one step and no further.
    // Measured 11272.
    //
    // 13 KiB (was 12): the August audit fixes, 174 gzip bytes against 18 bytes
    // of remaining headroom. Every one of them closes a path that silently LOST
    // data rather than adding a capability:
    //   - a conversion queued while backoff was armed never reached the durable
    //     bucket, so a purchase firing moments after a rate-limited event died
    //     on the checkout redirect (goal-queue.ts);
    //   - drainBucket cleared storage before the send was acknowledged, so a
    //     backlog larger than one flush was lost on the next unload;
    //   - a bfcache restore kept banking dwell for sections the visitor had
    //     scrolled past, with the observer that could correct it disconnected
    //     (engagement/capture.ts);
    //   - a failed session upsert made every later conversion 400, which the
    //     queue treats as terminal — silently, and with no retry (index.ts).
    // The same reasoning as the durable goal queue applies: the weight buys a
    // delivery guarantee for revenue events, so it stays. Budget moves one step
    // and no further. Measured 12270.
    //
    // Re-baselined 13→14 KB. locator-from-dom.ts (+~455 bytes gzip) is used by
    // the graph and engagement entries, so tsup places it in the SHARED chunk —
    // and this bundle is measured as (shared chunk + entry). The lean entry
    // therefore pays for a generator it never calls. Splitting it out would mean
    // duplicating it into both consuming entries, which is worse for the common
    // case (the React provider uses engagement capture by default), so the
    // shared chunk is the right placement and the lean budget absorbs it.
    // Revisit if a lean-only consumer ever needs those bytes back.
    limit: 14 * 1024,
  },
  {
    name: '@sentientui/core/graph (additions only)',
    entry: 'index-graph.mjs',
    // scanner + graph on top of the shared chunk.
    // Re-baselined 16→17 KB for locatorFromElement (+452 bytes gzip, measured
    // 15913→16365). That generator is the live-DOM twin of the server's
    // locatorFromNode, and it is what lets the crawler and the SDK derive the
    // SAME section_key for one physical section. Without it a client-rendered
    // page has no stable section identity at all, so every per-section number
    // downstream splits in two. Budget moves one step and no further.
    limit: 17 * 1024,
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
