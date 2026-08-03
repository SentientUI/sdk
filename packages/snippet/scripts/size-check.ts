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
  { name: '@sentientui/snippet (always-on)', file: 'snippet.global.js', limit: 16 * 1024 },
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
