import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.js' };
  },
  dts: true,
  clean: true,
  target: 'es2017',
  minify: true,
});
