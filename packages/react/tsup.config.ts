import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Read the package version at build time and inject it into every bundle, so
// the version this SDK reports to the dashboard (see src/sdk-version.ts) always
// matches what's published. Applied to ALL entries, not just the main one: the
// provider is re-bundled into the next/ entries too, and an entry without the
// define would ship the dev sentinel and report nothing.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };
const define = { __REACT_SDK_VERSION__: JSON.stringify(pkg.version) };

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
    define,
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
    define,
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
    define,
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
    define,
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
    define,
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
    define,
    minify: true,
  },
  {
    // msw-dependent testing helpers — separate entry so the main ./testing
    // entry never imports the OPTIONAL msw peer at module top level (which
    // crashed consumers without msw installed).
    entry: { 'testing/msw': 'src/testing/msw.ts' },
    format: ['esm', 'cjs'],
    outExtension,
    dts: true,
    sourcemap: true,
    external: ['msw'],
    target: 'es2017',
    define,
    minify: true,
  },
  {
    // @testing-library/react-dependent testing helpers — separate entry so the
    // main ./testing entry never imports the OPTIONAL RTL peer at module top
    // level (which crashed consumers without it installed).
    entry: { 'testing/react': 'src/testing/react.tsx' },
    format: ['esm', 'cjs'],
    outExtension,
    dts: true,
    sourcemap: true,
    banner: { js: "'use client';" },
    external: ['react', '@sentientui/core', '@sentientui/react', '@sentientui/policy', '@testing-library/react'],
    target: 'es2017',
    define,
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
    define,
    minify: true,
  },
]);
