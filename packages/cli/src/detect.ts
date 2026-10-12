import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type Framework =
  | 'next-app'
  | 'next-pages'
  | 'react-router'
  | 'remix'
  | 'gatsby'
  | 'astro'
  | 'vite'
  | 'cra'
  | 'unknown';
export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
};

function readPackageJson(cwd: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf-8')) as PackageJson;
  } catch {
    return null;
  }
}

export function detectFramework(cwd: string): Framework {
  const pkg = readPackageJson(cwd);
  if (!pkg) return 'unknown';
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (dir: string) => existsSync(path.join(cwd, dir));
  if (deps['next']) {
    if (has('app') || has(path.join('src', 'app'))) return 'next-app';
    if (has('pages') || has(path.join('src', 'pages'))) return 'next-pages';
    return 'next-app'; // App Router is the default for new Next apps
  }
  // React Router v7 framework mode is Remix's successor and ships `vite` as a
  // devDependency, so it must be checked BEFORE the vite branch — otherwise it
  // was reported as a plain Vite SPA and told to edit a src/main.tsx that a
  // framework-mode app does not have. Library-mode `react-router` alone (no
  // @react-router/* framework package) is just a router inside some other
  // build, so it falls through to that build's branch.
  if (Object.keys(deps).some((d) => d.startsWith('@react-router/'))) return 'react-router';
  if (deps['@remix-run/react'] || deps['@remix-run/node']) return 'remix';
  // Gatsby and Astro used to fall through to 'unknown' — or, for an Astro
  // project with a vite devDependency, to 'vite', writing a VITE_ env var Astro
  // never exposes to the client. Both are checked before vite for that reason.
  if (deps['gatsby']) return 'gatsby';
  if (deps['astro']) return 'astro';
  if (deps['react-scripts']) return 'cra';
  if (deps['vite']) return 'vite';
  return 'unknown';
}

const LOCKFILES: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['pnpm-workspace.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

function fromPackageManagerField(pkg: PackageJson | null): PackageManager | null {
  const name = pkg?.packageManager?.split('@')[0];
  return name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm' ? name : null;
}

/**
 * Package manager for `cwd`, looking UP the tree.
 *
 * This used to check only `cwd` itself. Inside a monorepo the lockfile lives at
 * the workspace root, not in the app package, so init fell back to npm and ran
 * `npm install` in a pnpm/yarn workspace package — which fails on `workspace:`
 * dependency specifiers (and leaves a stray package-lock.json behind). The walk
 * stops at the repository root (a directory containing `.git`) or the
 * filesystem root, so an unrelated lockfile in a parent like $HOME is never
 * adopted. A corepack `packageManager` field is honoured at each level,
 * nearest first.
 */
export function detectPackageManager(cwd: string): PackageManager {
  let dir = path.resolve(cwd);
  for (;;) {
    const field = fromPackageManagerField(readPackageJson(dir));
    if (field) return field;
    for (const [file, pm] of LOCKFILES) {
      if (existsSync(path.join(dir, file))) return pm;
    }
    const parent = path.dirname(dir);
    if (existsSync(path.join(dir, '.git')) || parent === dir) return 'npm';
    dir = parent;
  }
}

export function installCommand(pm: PackageManager, pkgName: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm add ${pkgName}`;
    case 'yarn':
      return `yarn add ${pkgName}`;
    case 'bun':
      return `bun add ${pkgName}`;
    case 'npm':
      return `npm install ${pkgName}`;
  }
}
