import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type Framework = 'next-app' | 'next-pages' | 'vite' | 'remix' | 'cra' | 'unknown';
export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
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
  if (deps['@remix-run/react'] || deps['@remix-run/node']) return 'remix';
  if (deps['react-scripts']) return 'cra';
  if (deps['vite']) return 'vite';
  return 'unknown';
}

export function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(cwd, 'bun.lockb')) || existsSync(path.join(cwd, 'bun.lock'))) return 'bun';
  return 'npm';
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
