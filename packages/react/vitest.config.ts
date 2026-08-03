import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@sentientui/core/local': fileURLToPath(new URL('../core/src/index-local.ts', import.meta.url)),
      '@sentientui/policy': fileURLToPath(new URL('../policy/src/index.ts', import.meta.url)),
      '@sentientui/core/server': fileURLToPath(new URL('../core/src/index-server.ts', import.meta.url)),
      '@sentientui/core/graph': fileURLToPath(new URL('../core/src/index-graph.ts', import.meta.url)),
      '@sentientui/core/engagement': fileURLToPath(new URL('../core/src/index-engagement.ts', import.meta.url)),
      '@sentientui/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
