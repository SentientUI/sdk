import { defineConfig } from 'tsup';

export default defineConfig({
  // index-server is a separate entry so SSR helpers (server.ts) never land in
  // the browser bundles; code shared with the lean entry stays in the chunk.
  entry: ['src/index.ts', 'src/index-graph.ts', 'src/index-engagement.ts', 'src/index-server.ts', 'src/index-local.ts', 'src/index-local-stub.ts'],
  format: ['esm', 'cjs'],
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.js' };
  },
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2017',
  minify: true,
  // Keep the self-subpath a bare specifier so the CONSUMER's bundler resolves
  // the development/production export conditions (mirrors how the react
  // provider dynamically imports '@sentientui/core/graph').
  external: ['@sentientui/core/local'],
});
