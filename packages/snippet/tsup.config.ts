import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Read the package version at build time and inject it into the bundle via
// `define` below, so the exported `version` always matches what's published.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  // Two IIFE bundles: the lean always-on snippet, and a separate editor overlay
  // loaded lazily only in ?sentient_editor= mode (zero bytes on the normal path,
  // so it never counts against the snippet's 16 KB budget). Each bundle has its
  // own gzip budget enforced by scripts/size-check.ts.
  entry: { snippet: 'src/index.ts', editor: 'src/editor/index.ts' },
  format: ['iife'],
  globalName: 'SentientSnippet',
  platform: 'browser',
  target: 'es2017',
  minify: true,
  clean: true,
  noExternal: [/@sentientui\/core/],
  define: { __SNIPPET_VERSION__: JSON.stringify(pkg.version) },
});
