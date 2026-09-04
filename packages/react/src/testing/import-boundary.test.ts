import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// msw and @testing-library/react are OPTIONAL peers. Their helpers live behind
// dedicated subpaths (`/testing/msw`, `/testing/react`, `/testing/node`) for a
// reason documented in msw.ts's header: a top-level `import { http } from 'msw'`
// reachable from the main `/testing` entry crashed every consumer WITHOUT msw
// installed the moment they imported ANY testing helper (applyScenario, the
// Playwright/Cypress mocks, ...). Nothing else pins that boundary — a
// well-meaning re-export added to index.tsx would ship green and break
// consumers at import time. This test statically walks the import graph of
// index.tsx (source-regex sweep, same precedent as
// apps/api/src/automation-contract.test.ts) and fails on any static path to
// the optional peers.
const FORBIDDEN = /^(?:msw|@testing-library\/react)(?:\/|$)/;

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(here, 'index.tsx');

type Spec = { spec: string; dynamic: boolean };

/** Static import/export-from/side-effect specifiers plus dynamic import() ones. */
function importSpecs(source: string): Spec[] {
  const specs: Spec[] = [];
  // Order matters: try dynamic import() first so `import('x')` is not half-eaten
  // by the static branch. Handles `import ... from 'x'`, `export ... from 'x'`,
  // bare `import 'x'`, and `import('x')`; type-only imports are swept too —
  // erased at runtime, so a false positive there is a conscious exception, not
  // a shipped crash.
  const re =
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1] !== undefined) specs.push({ spec: m[1], dynamic: true });
    else if (m[2] !== undefined) specs.push({ spec: m[2], dynamic: false });
  }
  return specs;
}

/** Resolve a relative `./x.js` specifier to its .ts/.tsx source file. */
function resolveRelative(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ''));
  for (const cand of [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx'), base]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  throw new Error(`import-boundary: cannot resolve '${spec}' from ${fromFile}`);
}

function walk(entry: string): { visited: Set<string>; violations: string[] } {
  const visited = new Set<string>();
  const violations: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const { spec, dynamic } of importSpecs(readFileSync(file, 'utf-8'))) {
      if (spec.startsWith('.')) {
        // A dynamic relative import IS the documented lazy path: it does not
        // execute at module-load, so it cannot crash a consumer at import
        // time. Do not traverse through it.
        if (!dynamic) queue.push(resolveRelative(file, spec));
      } else if (FORBIDDEN.test(spec) && !dynamic) {
        violations.push(`${basename(file)} statically imports '${spec}'`);
      }
    }
  }
  return { visited, violations };
}

describe('/testing entry keeps msw and @testing-library/react optional', () => {
  const { visited, violations } = walk(ENTRY);
  const names = new Set([...visited].map((f) => basename(f)));

  it('no file statically reachable from index.tsx imports an optional peer', () => {
    expect(violations).toEqual([]);
  });

  it('the walk actually covers the helper modules (guards against a broken resolver)', () => {
    // If the resolver silently stopped following imports, the sweep above
    // would pass vacuously. Pin the modules known to be reachable today.
    for (const f of ['index.tsx', 'scenario.ts', 'resolve.ts', 'events.ts', 'playwright.ts', 'cypress.ts']) {
      expect(names, `expected the import walk to reach ${f}`).toContain(f);
    }
  });

  it('the peer-dependent modules stay outside the main-entry graph', () => {
    // handlers.ts (msw) and react.tsx (@testing-library/react) belong to the
    // /testing/msw and /testing/react subpaths. If either becomes reachable
    // from index.tsx the first test fails on the peer import itself — this one
    // makes the intended shape explicit.
    expect(names).not.toContain('handlers.ts');
    expect(names).not.toContain('msw.ts');
    expect(names).not.toContain('node.ts');
    expect(names).not.toContain('react.tsx');
  });
});
