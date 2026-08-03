import { defineConfig } from 'tsup';

const outExtension = ({ format }: { format: string }) => ({
  js: format === 'esm' ? '.mjs' : '.js',
});

/** Next.js resolves `.js` imports literally; keep ESM output as `.js` (not `.mjs`). */
const nextOutExtension = () => ({ js: '.js' });

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    outExtension,
    dts: true,
    sourcemap: true,
    clean: true,
    banner: { js: "'use client';" },
    external: ['react', '@sentientui/core', '@sentientui/policy'],
    target: 'es2017',
    minify: true,
  },
  {
    entry: { server: 'src/server.ts' },
    format: ['esm', 'cjs'],
    outExtension,
    dts: true,
    sourcemap: true,
    external: ['@sentientui/core', '@sentientui/core/server', '@sentientui/core/local', '@sentientui/policy'],
    target: 'es2017',
    minify: true,
  },
  {
    entry: { 'next/adaptive-root-client': 'src/next/adaptive-root-client.tsx' },
    format: ['esm'],
    outExtension: nextOutExtension,
    dts: true,
    sourcemap: true,
    banner: { js: "'use client';" },
    external: ['react', '@sentientui/core', '@sentientui/react'],
    target: 'es2017',
    minify: true,
  },
  {
    entry: { 'next/adaptive-root': 'src/next/adaptive-root.tsx' },
    format: ['esm'],
    outExtension: nextOutExtension,
    dts: true,
    sourcemap: true,
    external: [
      'react',
      '@sentientui/core',
      '@sentientui/core/server',
      '@sentientui/policy',
      'next/headers',
      './adaptive-root-client.js',
    ],
    target: 'es2017',
    minify: true,
  },
  {
    entry: { devtools: 'src/devtools/index.tsx' },
    format: ['esm', 'cjs'],
    outExtension,
    dts: true,
    sourcemap: true,
    banner: { js: "'use client';" },
    external: ['react', '@sentientui/core', '@sentientui/core/local', '@sentientui/policy', '@sentientui/react'],
    target: 'es2017',
    minify: true,
  },
  {
    entry: { testing: 'src/testing/index.tsx' },
    format: ['esm', 'cjs'],
    outExtension,
    dts: true,
    sourcemap: true,
    banner: { js: "'use client';" },
    external: ['react', '@sentientui/core', '@sentientui/react', '@sentientui/policy', '@testing-library/react'],
    target: 'es2017',
    minify: true,
  },
  {
    // Node-only testing helpers (msw/node) — separate entry so the main
    // ./testing entry stays browser-bundle-safe (Cypress/webpack).
    entry: { 'testing/node': 'src/testing/node.ts' },
    format: ['esm', 'cjs'],
    outExtension,
    dts: true,
    sourcemap: true,
    external: ['react', '@sentientui/core', '@sentientui/react', 'msw'],
    target: 'es2017',
    minify: true,
  },
]);
