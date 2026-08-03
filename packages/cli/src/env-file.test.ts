import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeEnvFile, envVarName } from './env-file.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sentientui-env-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const envPath = () => path.join(dir, '.env.local');

describe('envVarName', () => {
  it('uses the client-exposed prefix each framework actually inlines', () => {
    expect(envVarName('vite')).toBe('VITE_SENTIENT_API_KEY');
    expect(envVarName('next-app')).toBe('NEXT_PUBLIC_SENTIENT_API_KEY');
    expect(envVarName('next-pages')).toBe('NEXT_PUBLIC_SENTIENT_API_KEY');
    // Remix v2 is Vite-powered → VITE_ prefix (import.meta.env).
    expect(envVarName('remix')).toBe('VITE_SENTIENT_API_KEY');
    // CRA only inlines REACT_APP_-prefixed vars.
    expect(envVarName('cra')).toBe('REACT_APP_SENTIENT_API_KEY');
  });
});

describe('writeEnvFile', () => {
  it('creates .env.local with an empty key and the local-mode comment', () => {
    expect(writeEnvFile(dir, 'next-app', undefined)).toBe('created');
    const content = readFileSync(envPath(), 'utf-8');
    expect(content).toContain('NEXT_PUBLIC_SENTIENT_API_KEY=');
    expect(content).toContain('leave empty for local mode');
  });

  it('writes the key when provided (--key)', () => {
    writeEnvFile(dir, 'next-app', 'pk_live_abc');
    expect(readFileSync(envPath(), 'utf-8')).toContain('NEXT_PUBLIC_SENTIENT_API_KEY=pk_live_abc');
  });

  it('appends to an existing file, preserving other keys byte-for-byte', () => {
    writeFileSync(envPath(), 'DATABASE_URL=postgres://x\n');
    expect(writeEnvFile(dir, 'next-app', undefined)).toBe('appended');
    const content = readFileSync(envPath(), 'utf-8');
    expect(content.startsWith('DATABASE_URL=postgres://x\n')).toBe(true);
    expect(content).toContain('NEXT_PUBLIC_SENTIENT_API_KEY=');
  });

  it('never clobbers an existing assignment (even an empty one)', () => {
    writeFileSync(envPath(), 'NEXT_PUBLIC_SENTIENT_API_KEY=pk_existing\n');
    expect(writeEnvFile(dir, 'next-app', 'pk_new')).toBe('kept');
    expect(readFileSync(envPath(), 'utf-8')).toBe('NEXT_PUBLIC_SENTIENT_API_KEY=pk_existing\n');
  });

  it('treats a commented-out assignment as present (no confusing duplicate appended)', () => {
    writeFileSync(envPath(), '# NEXT_PUBLIC_SENTIENT_API_KEY=pk_old_commented\n');
    expect(writeEnvFile(dir, 'next-app', 'pk_new')).toBe('kept');
    // File left byte-for-byte untouched — we do not append a second (active) copy.
    expect(readFileSync(envPath(), 'utf-8')).toBe('# NEXT_PUBLIC_SENTIENT_API_KEY=pk_old_commented\n');
  });

  it('uses the VITE_ variable for vite projects', () => {
    writeEnvFile(dir, 'vite', undefined);
    expect(readFileSync(envPath(), 'utf-8')).toContain('VITE_SENTIENT_API_KEY=');
    expect(existsSync(envPath())).toBe(true);
  });
});
