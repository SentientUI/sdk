import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectFramework, detectPackageManager, installCommand } from './detect.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sentientui-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePkg(deps: Record<string, string>, devDeps: Record<string, string> = {}): void {
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: deps, devDependencies: devDeps }),
  );
}

describe('detectFramework', () => {
  it('next + app/ → next-app', () => {
    writePkg({ next: '15.0.0', react: '18.3.1' });
    mkdirSync(path.join(dir, 'app'));
    expect(detectFramework(dir)).toBe('next-app');
  });
  it('next + src/app → next-app', () => {
    writePkg({ next: '15.0.0' });
    mkdirSync(path.join(dir, 'src', 'app'), { recursive: true });
    expect(detectFramework(dir)).toBe('next-app');
  });
  it('next + pages/ → next-pages', () => {
    writePkg({ next: '15.0.0' });
    mkdirSync(path.join(dir, 'pages'));
    expect(detectFramework(dir)).toBe('next-pages');
  });
  it('next + src/pages → next-pages', () => {
    writePkg({ next: '15.0.0' });
    mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
    expect(detectFramework(dir)).toBe('next-pages');
  });
  it('next with neither marker defaults to next-app', () => {
    writePkg({ next: '15.0.0' });
    expect(detectFramework(dir)).toBe('next-app');
  });
  it('vite (devDependency) → vite', () => {
    writePkg({ react: '18.3.1' }, { vite: '6.0.0' });
    expect(detectFramework(dir)).toBe('vite');
  });
  it('remix → remix', () => {
    writePkg({ '@remix-run/react': '2.15.0' });
    expect(detectFramework(dir)).toBe('remix');
  });
  it('react-scripts → cra', () => {
    writePkg({ 'react-scripts': '5.0.1' });
    expect(detectFramework(dir)).toBe('cra');
  });
  it('next wins over vite when both are present', () => {
    writePkg({ next: '15.0.0' }, { vite: '6.0.0' });
    mkdirSync(path.join(dir, 'app'));
    expect(detectFramework(dir)).toBe('next-app');
  });
  it('react-router v7 framework mode → react-router (before vite)', () => {
    writePkg({ 'react-router': '7.0.0', '@react-router/node': '7.0.0' }, { '@react-router/dev': '7.0.0', vite: '6.0.0' });
    expect(detectFramework(dir)).toBe('react-router');
  });
  it('library-mode react-router inside a vite app stays vite', () => {
    writePkg({ 'react-router': '7.0.0' }, { vite: '6.0.0' });
    expect(detectFramework(dir)).toBe('vite');
  });
  it('gatsby → gatsby', () => {
    writePkg({ gatsby: '5.0.0', react: '18.3.1' });
    expect(detectFramework(dir)).toBe('gatsby');
  });
  it('astro (with a vite devDependency) → astro, not vite', () => {
    writePkg({ astro: '5.0.0', '@astrojs/react': '4.0.0' }, { vite: '6.0.0' });
    expect(detectFramework(dir)).toBe('astro');
  });
  it('no package.json → unknown', () => {
    expect(detectFramework(dir)).toBe('unknown');
  });
  it('unrecognized deps → unknown', () => {
    writePkg({ express: '4.0.0' });
    expect(detectFramework(dir)).toBe('unknown');
  });
});

describe('detectPackageManager', () => {
  it('pnpm-lock.yaml → pnpm', () => {
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    expect(detectPackageManager(dir)).toBe('pnpm');
  });
  it('yarn.lock → yarn', () => {
    writeFileSync(path.join(dir, 'yarn.lock'), '');
    expect(detectPackageManager(dir)).toBe('yarn');
  });
  it('bun.lockb → bun', () => {
    writeFileSync(path.join(dir, 'bun.lockb'), '');
    expect(detectPackageManager(dir)).toBe('bun');
  });
  it('no lockfile → npm', () => {
    mkdirSync(path.join(dir, '.git'));
    expect(detectPackageManager(dir)).toBe('npm');
  });
  it('bun.lock (text lockfile) → bun', () => {
    writeFileSync(path.join(dir, 'bun.lock'), '');
    expect(detectPackageManager(dir)).toBe('bun');
  });
  it('walks up to a workspace-root lockfile', () => {
    writeFileSync(path.join(dir, 'yarn.lock'), '');
    const pkg = path.join(dir, 'packages', 'site');
    mkdirSync(pkg, { recursive: true });
    expect(detectPackageManager(pkg)).toBe('yarn');
  });
  it('pnpm-workspace.yaml alone marks a pnpm workspace', () => {
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []');
    const pkg = path.join(dir, 'apps', 'web');
    mkdirSync(pkg, { recursive: true });
    expect(detectPackageManager(pkg)).toBe('pnpm');
  });
  it('honours the packageManager field', () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.1.0' }));
    expect(detectPackageManager(dir)).toBe('yarn');
  });
  it('stops at the repository root (.git) — a lockfile above it is not adopted', () => {
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const repo = path.join(dir, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    expect(detectPackageManager(repo)).toBe('npm');
  });
});

describe('installCommand', () => {
  it('maps package manager to its add command', () => {
    expect(installCommand('pnpm', '@sentientui/react')).toBe('pnpm add @sentientui/react');
    expect(installCommand('yarn', '@sentientui/react')).toBe('yarn add @sentientui/react');
    expect(installCommand('bun', '@sentientui/react')).toBe('bun add @sentientui/react');
    expect(installCommand('npm', '@sentientui/react')).toBe('npm install @sentientui/react');
  });
});
