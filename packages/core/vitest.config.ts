import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Order matters: subpath keys must precede the package root.
      '@sentientui/core/local': fileURLToPath(new URL('./src/index-local.ts', import.meta.url)),
      '@sentientui/policy': fileURLToPath(new URL('../policy/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
