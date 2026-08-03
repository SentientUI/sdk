import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve workspace deps to SOURCE (repo convention — see react/core
      // configs): CI runs tests without building, so dist/ may not exist.
      // Order matters: subpath keys must precede the package root.
      '@sentientui/core/local': fileURLToPath(new URL('../core/src/index-local.ts', import.meta.url)),
      '@sentientui/core/engagement': fileURLToPath(new URL('../core/src/index-engagement.ts', import.meta.url)),
      '@sentientui/policy': fileURLToPath(new URL('../policy/src/index.ts', import.meta.url)),
      '@sentientui/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: { environment: 'jsdom', globals: true },
});
