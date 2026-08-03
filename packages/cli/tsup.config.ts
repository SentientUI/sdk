import { defineConfig } from 'tsup';

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
  banner: { js: '#!/usr/bin/env node' },
});
