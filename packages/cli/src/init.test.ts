import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInit } from './init.js';

let dir: string;
let calls: string[];
let lines: string[];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sentientui-init-'));
  calls = [];
  lines = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const opts = () => ({
  cwd: dir,
  exec: (cmd: string) => {
    calls.push(cmd);
  },
  log: (line: string) => {
    lines.push(line);
  },
});

function nextAppFixture(): void {
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0' } }));
  mkdirSync(path.join(dir, 'app'));
}

describe('runInit', () => {
  it('next-app: installs with npm (no lockfile), writes env, scaffolds, prints snippet + finale', () => {
    nextAppFixture();
    const result = runInit(opts());
    expect(result.framework).toBe('next-app');
    expect(calls).toEqual(['npm install @sentientui/react']);
    expect(readFileSync(path.join(dir, '.env.local'), 'utf-8')).toContain('NEXT_PUBLIC_SENTIENT_API_KEY=');
    expect(existsSync(path.join(dir, 'components', 'adaptive-example.tsx'))).toBe(true);
    const out = lines.join('\n');
    expect(out).toContain('<AdaptiveRoot');
    expect(out).toContain('open http://localhost:3000/?sentient_persona=a');
    expect(out).toContain('data-sentient-persona="a"');
  });

  it('uses the detected package manager (pnpm lockfile → pnpm add)', () => {
    nextAppFixture();
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    runInit(opts());
    expect(calls).toEqual(['pnpm add @sentientui/react']);
  });

  it('--key writes the key into .env.local', () => {
    nextAppFixture();
    runInit({ ...opts(), key: 'pk_live_xyz' });
    expect(readFileSync(path.join(dir, '.env.local'), 'utf-8')).toContain('NEXT_PUBLIC_SENTIENT_API_KEY=pk_live_xyz');
  });

  // `init` then `init --key pk_…` is the natural onboarding order (try local
  // mode, then paste the real key). The env writer used to keep the old empty
  // assignment while the log printed `VAR=pk_…` as if it had been written.
  it('--key on an already-initialized repo overwrites the empty assignment and logs the write', () => {
    nextAppFixture();
    runInit(opts()); // keyless init → NEXT_PUBLIC_SENTIENT_API_KEY=
    runInit({ ...opts(), key: 'pk_live_xyz' });
    expect(readFileSync(path.join(dir, '.env.local'), 'utf-8')).toContain('NEXT_PUBLIC_SENTIENT_API_KEY=pk_live_xyz');
    const out = lines.join('\n');
    expect(out).toContain('.env.local updated: NEXT_PUBLIC_SENTIENT_API_KEY=pk_live_xyz');
  });

  it('--key matching the configured key logs kept — and never claims a write', () => {
    nextAppFixture();
    runInit({ ...opts(), key: 'pk_live_xyz' });
    lines.length = 0;
    runInit({ ...opts(), key: 'pk_live_xyz' });
    const out = lines.join('\n');
    expect(out).toContain('.env.local kept: NEXT_PUBLIC_SENTIENT_API_KEY is already set to this key');
    expect(out).not.toContain('.env.local kept: NEXT_PUBLIC_SENTIENT_API_KEY=');
  });

  it('does not warn for a publishable pk_ key', () => {
    nextAppFixture();
    runInit({ ...opts(), key: 'pk_live_xyz' });
    expect(lines.join('\n')).not.toMatch(/SECURITY WARNING/);
  });

  it('ABORTS on a secret sk_ key: errors and never writes it to .env.local', () => {
    nextAppFixture();
    expect(() => runInit({ ...opts(), key: 'sk_live_secret' })).toThrow(/publishable pk_/i);
    // The secret must not have been written into client-exposed env.
    expect(existsSync(path.join(dir, '.env.local'))).toBe(false);
    const out = lines.join('\n');
    expect(out).toMatch(/SECURITY WARNING/);
    expect(out).toMatch(/secret server key/i);
  });

  it('ABORTS on any non-pk_ key without writing env', () => {
    nextAppFixture();
    expect(() => runInit({ ...opts(), key: 'garbage' })).toThrow(/publishable pk_/i);
    expect(existsSync(path.join(dir, '.env.local'))).toBe(false);
  });

  it('vite: VITE_ env var, src/components scaffold target, port 5173 finale', () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { vite: '6.0.0' } }));
    mkdirSync(path.join(dir, 'src'));
    const result = runInit(opts());
    expect(result.framework).toBe('vite');
    expect(readFileSync(path.join(dir, '.env.local'), 'utf-8')).toContain('VITE_SENTIENT_API_KEY=');
    expect(existsSync(path.join(dir, 'src', 'components', 'adaptive-example.tsx'))).toBe(true);
    expect(lines.join('\n')).toContain('open http://localhost:5173/?sentient_persona=a');
  });

  it('never clobbers an existing example component', () => {
    nextAppFixture();
    mkdirSync(path.join(dir, 'components'));
    writeFileSync(path.join(dir, 'components', 'adaptive-example.tsx'), '// mine');
    runInit(opts());
    expect(readFileSync(path.join(dir, 'components', 'adaptive-example.tsx'), 'utf-8')).toBe('// mine');
  });

  it('unknown framework: instructions only — no install, no files', () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '4.0.0' } }));
    const result = runInit(opts());
    expect(result.framework).toBe('unknown');
    expect(calls).toEqual([]);
    expect(existsSync(path.join(dir, '.env.local'))).toBe(false);
    expect(lines.join('\n')).toContain('could not detect');
  });
  // M15: the verification step used to promise the two persona URLs "render
  // differently" — impossible with the scaffold, which shows its original
  // until a dashboard version is published.
  it('verification points at the <html> persona attribute, not a visual difference', () => {
    nextAppFixture();
    runInit(opts());
    const out = lines.join('\n');
    expect(out).toContain('data-sentient-persona');
    expect(out).not.toMatch(/render differently/);
  });

  it('--no-install skips the install and prints the command instead', () => {
    nextAppFixture();
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    runInit({ ...opts(), install: false });
    expect(calls).toEqual([]);
    expect(lines.join('\n')).toContain('run it yourself: pnpm add @sentientui/react');
    // Everything else still happens.
    expect(existsSync(path.join(dir, '.env.local'))).toBe(true);
  });

  // M16: a workspace package has no lockfile of its own; npm there breaks
  // `workspace:` specifiers.
  it('inside a pnpm workspace package, installs with pnpm from the root lockfile', () => {
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    mkdirSync(path.join(dir, '.git'));
    const app = path.join(dir, 'apps', 'web');
    mkdirSync(path.join(app, 'app'), { recursive: true });
    writeFileSync(path.join(app, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0' } }));
    runInit({ ...opts(), cwd: app });
    expect(calls).toEqual(['pnpm add @sentientui/react']);
  });

  it('gatsby: GATSBY_ var in .env.development (Gatsby ignores .env.local), port 8000', () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { gatsby: '5.0.0' } }));
    mkdirSync(path.join(dir, 'src'));
    const result = runInit(opts());
    expect(result.framework).toBe('gatsby');
    expect(readFileSync(path.join(dir, '.env.development'), 'utf-8')).toContain('GATSBY_SENTIENT_API_KEY=');
    expect(existsSync(path.join(dir, '.env.local'))).toBe(false);
    const out = lines.join('\n');
    expect(out).toContain('.env.development created');
    expect(out).toContain('wrapRootElement');
    expect(out).toContain('http://localhost:8000/');
  });

  it('astro: PUBLIC_ var, island-level provider, port 4321', () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { astro: '5.0.0' }, devDependencies: { vite: '6.0.0' } }));
    const result = runInit(opts());
    expect(result.framework).toBe('astro');
    expect(readFileSync(path.join(dir, '.env.local'), 'utf-8')).toContain('PUBLIC_SENTIENT_API_KEY=');
    const out = lines.join('\n');
    expect(out).toContain('client:load');
    expect(out).toContain('http://localhost:4321/');
  });
});
