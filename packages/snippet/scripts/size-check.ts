import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSnippetPrePaintScript } from '../src/prepaint-script';

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
  // Measured 23163 after the inline pre-paint script batch (+342 on the 22821
  // baseline), which is what the BUNDLE side of that work costs: the __sntPP
  // reconcile, the onAttr feed through apply.ts, the planReorder extraction and
  // the `pp` install-health report. The 2.6 KiB inline string itself is NOT in
  // here — it is deliberately not re-exported from src/index.ts, because it is
  // an install-time generator that only ever runs in Node (it lives on
  // '@sentientui/snippet/install' and is budgeted separately below). ~400 bytes
  // of headroom; the next addition needs a deliberate decision about this budget.
  //
  // Previous baseline notes, kept for the accounting trail:
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
  // 23 KiB (was 22): re-baselined 2026-09-05 (operator decision — "increase the
  // size to fit that") for the semantic-understanding batch, all of it
  // always-on capture code: per-element nc-* ids (locator-hash suffix, so two
  // same-typed bands stop collapsing into one dwell row), the client-sensor
  // observation on every section-map entry (structure + headings + which
  // shipped CONTENT_PATTERNS matched — the ONLY classification channel for
  // pages the crawler cannot fetch), the phase-2d structural-pinning branch in
  // the shared layout heuristic, and data-sentient-id in STABLE_DATA_ATTRS.
  // Measured 22721 (+819 on the 21902 baseline). ~830 bytes of headroom.
  //
  // Previous baseline note, kept for the accounting trail:
  // Re-baselined 21→22 KB for client-side locator generation. The snippet now
  // sends one section-map entry PER ELEMENT with its own compound locator,
  // instead of one per semantic TYPE — which is what gives each section its own
  // section_key. Without it a page whose bands all classify `generic` collapses
  // into a single nc-generic with summed dwell and no per-section identity at
  // all (measured on a real site: 8 of 9 sections generic). Measured 21902.
  // +256 at the empty-cell merge: the form-tree whole-refusal guard
  // (containsFormBlock filter in apply.ts — a form arm reaching the old partial
  // render would hide the merchant's section behind a form-less tree at
  // pre-paint, so it must be always-on) landed on top of the semantic-capture
  // re-baseline above. Measured 23593 against 23552.
  { name: '@sentientui/snippet (always-on)', file: 'snippet.global.js', limit: 23 * 1024 + 256 },
  // 20 KiB (was 18, 12): re-baselined 2026-09-07 for the editor audit
  // remediation — the 18 KiB note reserved ~1.8 KiB for "the review card and
  // the NL command box" and said the next addition needs a deliberate
  // decision; this IS that decision, and it went past the reservation because
  // four unreserved features shipped alongside the card. Measured 18799
  // (+2152 on the 16647 baseline): the post-save review card (spec §2.2's
  // last open item), draft DISCARD end-to-end (two-step arming + the bodyless
  // DELETE client — principle 5's "discardable", previously unimplemented),
  // goals in the Drafts tray (a saved-but-unactivated goal used to vanish
  // from view entirely), the keyboard layer (Esc back-out, arrow-key moves,
  // Tab target cycling — the editor was mouse-only, so this is the
  // accessibility floor, not chrome), and the dirty-form/work-loss guards.
  // None of it can be lazier: it is all inside the lazy bundle already.
  // Trimming was tried first — folding the two review cards and the three
  // discard sites into shared helpers bought 15 bytes, because gzip had
  // already priced the repetition. ~1.7 KiB of headroom left, which is what
  // the NL command box (spec §2.2b) still needs. Zero bytes of any of this
  // ride a visitor page view; the always-on budget above is the one that
  // protects visitors, and it is unchanged.
  //
  // Previous baseline notes, kept for the accounting trail:
  // 18 KiB (was 12): re-baselined 2026-09-06 (operator-directed editor UX
  // phase — "the conversation the composition spec predicted", had). Measured
  // 16647 (+5019 on the 11628 baseline): the tabbed panel, live style/text
  // preview, ancestor breadcrumb + recovery, Drafts tab with in-editor
  // preview, 💡 suggestion cards, minimize bubble, mapped failure copy, and
  // usage telemetry.

  // Measured 11628 (arrangement picker +521 on a palette-sampling 11107) —
  // 660 bytes of margin. The composition spec expected this budget to need
  // raising for the editor phase; it did NOT (the picker is forms — the server
  // owns catalog data and all rendering/validation). The next overlay feature
  // may still force that conversation; keep it deliberate.
  { name: '@sentientui/snippet (editor overlay)', file: 'editor.global.js', limit: 20 * 1024 },
];

let allOk = true;
for (const { name, file, limit } of bundles) {
  const size = gzipSync(readFileSync(join(__dirname, '../dist', file))).length;
  const ok = size <= limit;
  const msg = `${ok ? 'ok  ' : 'FAIL'}  ${name}: ${size} bytes gzip (limit: ${limit}, margin: ${limit - size})`;
  if (ok) console.log(msg);
  else { console.error(`${msg}  — over by ${size - limit} bytes`); allOk = false; }
}

// The inline pre-paint script (the install's middle tag), measured RAW rather
// than gzip: it is inlined into the merchant's HTML, so it rides that page's own
// compression and the raw bytes are what actually sit in the critical path. It
// is hand-minified at the source, so there is no build step to measure after.
//
// The design spec proposed 1.5 KiB. The full feature set — the gates, declared
// AND registry slot stamping with its unstamp-on-ambiguity rule, and the section
// reorder — did not fit in that, and cutting to fit would have meant dropping
// the reorder (spec §6 open decision 2), which is the largest visible flash and
// the main reason the script exists. Measured 2662 raw / ~1.1 KiB over the wire.
// The budget below is a drift guard, not a target: anything that grows this has
// to justify itself, because every byte here is synchronous work in <head>.
const PREPAINT_LIMIT = 3 * 1024;
const prePaintSize = Buffer.byteLength(renderSnippetPrePaintScript());
const prePaintOk = prePaintSize <= PREPAINT_LIMIT;
const prePaintMsg =
  `${prePaintOk ? 'ok  ' : 'FAIL'}  @sentientui/snippet (inline pre-paint script): ` +
  `${prePaintSize} bytes raw (limit: ${PREPAINT_LIMIT}, margin: ${PREPAINT_LIMIT - prePaintSize})`;
if (prePaintOk) console.log(prePaintMsg);
else { console.error(`${prePaintMsg}  — over by ${prePaintSize - PREPAINT_LIMIT} bytes`); allOk = false; }

process.exit(allOk ? 0 : 1);
