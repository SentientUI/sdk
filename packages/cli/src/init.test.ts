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
    expect(out).toContain('<AdaptiveProvider');
    expect(out).toContain('open http://localhost:3000?sentient_persona=buyer');
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
    expect(lines.join('\n')).toContain('open http://localhost:5173?sentient_persona=buyer');
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
});
