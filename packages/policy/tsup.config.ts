import { defineConfig } from 'tsup';

export default defineConfig({
  // taxonomy is a SEPARATE entry, not part of the barrel: it is server-only
  // vocabulary, and re-exporting it from index.ts shipped all 44 topics into
  // the always-on snippet bundle (+405 bytes gzip on every page view of every
  // customer site) because browser code imports the barrel for confidenceBand.
  entry: ['src/index.ts', 'src/taxonomy.ts'],
  format: ['esm', 'cjs'],
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.js' };
  },
  dts: true,
  clean: true,
  target: 'es2017',
  minify: true,
});
