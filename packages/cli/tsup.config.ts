import { defineConfig } from 'tsup';
import { createRequire } from 'node:module';

// `--version` has to print the version that was actually published, and this
// package is ESM with no JSON import assertion — so the value is inlined at
// build time rather than read from disk at runtime (where the bin's relative
// path to package.json depends on how the consumer installed it).
const { version } = createRequire(import.meta.url)('./package.json') as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: false,
  clean: true,
  // es2022 (not the repo-wide es2017 tsup infers from the root tsconfig): the
  // bin's self-exec guard (src/index.ts) reads import.meta.url, and an es2017
  // target down-levels import.meta to an empty `{}` — leaving import.meta.url
  // undefined so `isRunAsScript()` never fires and the built bin does nothing.
  target: 'es2022',
  // shims:false — this is a single native-ESM bin. tsup's import.meta shim is
  // what caused the MCP boot crash; keep it off so import.meta stays native
  // (with the es2022 target above, esbuild emits it verbatim).
  shims: false,
  define: { __CLI_VERSION__: JSON.stringify(version) },
  banner: { js: '#!/usr/bin/env node' },
});
