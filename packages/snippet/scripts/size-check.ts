import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Each bundle has its own gzip budget, enforced in CI so neither silently drifts.
// - snippet.global.js is the ALWAYS-ON bundle: a tight budget matters because it
//   loads on every page view. Re-baselined 15→16 KB to reflect the shipped feature
//   set (slot ops engine, registry mode, goal wiring, section + per-option signal
//   capture, SPA hooks, preview modes).
// - editor.global.js is the on-site overlay, loaded LAZILY only in
//   ?sentient_editor= mode (zero bytes on the normal path), so its budget is
//   generous — it just guards against unbounded growth of the editor UI.
const bundles: Array<{ name: string; file: string; limit: number }> = [
  // 21 KiB (was 20, 18, 16): re-baselined 2026-09-01 for the September audit
  // bug-fix batch — measured 20746 (+677 on the 20069 baseline), all of it
  // always-on correctness code that cannot be lazy: the consent
  // revoke->grant re-init (a destroyed client silently dropped every event
  // for the rest of the visit), exposing the page API in editor/preview
  // modes (merchant page code threw on SentientSnippet.goal), and the core
  // changes that ride this bundle — the namespaced-cookie legacy fallback
  // (returning visitors' identity), the valued/valueless goal-key collapse
  // and the instanceof-Event latch guard (repeat conversions, CONTRACTS §1).
  // ~758 bytes of headroom left; the next addition needs a deliberate
  // decision about this budget.
  //
  // Previous baseline note, kept for the accounting trail:
  // 20 KiB (was 18, was 16): re-baselined 2026-08-28 (operator decision) for
  // the Composition Block renderer (B2 Phase 1, +1236 gzip on an 18322
  // baseline that already carried B1.1 section reordering at +453). The
  // renderer must be always-on because Option B pre-renders arms at pre-paint
  // (composition spec §6) — a lazy chunk would arrive after first paint and
  // reintroduce the flash the design exists to prevent. Measured 20069 (the
  // orphan-block teardown sweep added ~360: pre-paint hides the merchant's own
  // content, so the code that puts it back has to be always-on too). ~400 bytes
  // of headroom left for B2's remaining phases — the next addition needs a
  // deliberate decision about this budget.
  // Re-baselined 21→22 KB for client-side locator generation. The snippet now
  // sends one section-map entry PER ELEMENT with its own compound locator,
  // instead of one per semantic TYPE — which is what gives each section its own
  // section_key. Without it a page whose bands all classify `generic` collapses
  // into a single nc-generic with summed dwell and no per-section identity at
  // all (measured on a real site: 8 of 9 sections generic). Measured 21902.
  { name: '@sentientui/snippet (always-on)', file: 'snippet.global.js', limit: 22 * 1024 },
  // Measured 11628 (arrangement picker +521 on a palette-sampling 11107) —
  // 660 bytes of margin. The composition spec expected this budget to need
  // raising for the editor phase; it did NOT (the picker is forms — the server
  // owns catalog data and all rendering/validation). The next overlay feature
  // may still force that conversation; keep it deliberate.
  { name: '@sentientui/snippet (editor overlay)', file: 'editor.global.js', limit: 12 * 1024 },
];

let allOk = true;
for (const { name, file, limit } of bundles) {
  const size = gzipSync(readFileSync(join(__dirname, '../dist', file))).length;
  const ok = size <= limit;
  const msg = `${ok ? 'ok  ' : 'FAIL'}  ${name}: ${size} bytes gzip (limit: ${limit}, margin: ${limit - size})`;
  if (ok) console.log(msg);
  else { console.error(`${msg}  — over by ${size - limit} bytes`); allOk = false; }
}
process.exit(allOk ? 0 : 1);
