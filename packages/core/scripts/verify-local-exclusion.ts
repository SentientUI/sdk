/**
 * Build-level guard: production bundles must physically contain no
 * local-engine code.
 *
 * Checks, in order:
 *  1. dist grep — the main entry bundles never inline the engine (the dynamic
 *     import must have stayed a bare specifier), the dev entry contains the
 *     sentinel (self-test), the stub does not.
 *  2. Node resolver — `--conditions=production` (and the no-condition default)
 *     resolve `@sentientui/core/local` to the stub; `--conditions=development`
 *     resolves to the engine. Uses package self-reference from the package root.
 *  3. esbuild consumer bundle — a fixture resolved from packages/react (which
 *     depends on @sentientui/core) excludes/includes the sentinel per condition.
 *
 * Run AFTER `pnpm --filter @sentientui/core build`:
 *   pnpm --filter @sentientui/core verify:local-exclusion
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const SENTINEL = 'SENTIENT_LOCAL_ENGINE';
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reactRoot = path.resolve(pkgRoot, '..', 'react');

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
}

// --- 1. dist grep ---------------------------------------------------------
for (const file of ['dist/index.mjs', 'dist/index.js']) {
  const text = readFileSync(path.join(pkgRoot, file), 'utf-8');
  check(`main bundle excludes engine (${file})`, !text.includes(SENTINEL));
}
check(
  'dev entry contains sentinel (dist/index-local.mjs) [self-test]',
  readFileSync(path.join(pkgRoot, 'dist/index-local.mjs'), 'utf-8').includes(SENTINEL),
);
check(
  'stub excludes sentinel (dist/index-local-stub.mjs)',
  !readFileSync(path.join(pkgRoot, 'dist/index-local-stub.mjs'), 'utf-8').includes(SENTINEL),
);

// --- 2. Node resolver (authoritative exports-map semantics) ----------------
function nodeResolves(conditions: string[]): string {
  const args = [
    ...conditions.flatMap((c) => ['--conditions', c]),
    '--input-type=module',
    '-e',
    "const m = await import('@sentientui/core/local'); console.log(m.LOCAL_ENGINE_AVAILABLE);",
  ];
  const res = spawnSync(process.execPath, args, { cwd: pkgRoot, encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`node ${conditions.join(',')} failed: ${res.stderr}`);
  return res.stdout.trim();
}
check('node production condition → stub', nodeResolves(['production']) === 'false');
check('node no condition (fallback) → stub', nodeResolves([]) === 'false');
check('node development condition → engine', nodeResolves(['development']) === 'true');

// --- 3. esbuild consumer bundle --------------------------------------------
async function bundledText(conditions: string[]): Promise<string> {
  const result = await build({
    stdin: {
      contents: "import('@sentientui/core/local').then((m) => console.log(m));",
      resolveDir: reactRoot, // packages/react depends on @sentientui/core
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    conditions,
    logLevel: 'silent',
  });
  return result.outputFiles.map((f) => f.text).join('\n');
}
check('esbuild production bundle excludes engine', !(await bundledText(['production'])).includes(SENTINEL));
check('esbuild development bundle includes engine', (await bundledText(['development'])).includes(SENTINEL));

if (failures > 0) {
  console.error(`${failures} bundle-safety check(s) failed`);
  process.exit(1);
}
console.log('bundle safety OK');
