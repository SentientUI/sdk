import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldExample } from './scaffold.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sentientui-scaffold-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('scaffoldExample', () => {
  it('writes components/adaptive-example.tsx when the app has no src/ dir', () => {
    const written = scaffoldExample(dir);
    expect(written).toBe(path.join(dir, 'components', 'adaptive-example.tsx'));
    expect(existsSync(path.join(dir, 'components', 'adaptive-example.tsx'))).toBe(true);
    expect(readFileSync(written!, 'utf-8')).toContain('useAdaptiveTokens');
  });

  it('writes src/components/adaptive-example.tsx when the app uses a src/ dir', () => {
    mkdirSync(path.join(dir, 'src'));
    const written = scaffoldExample(dir);
    expect(written).toBe(path.join(dir, 'src', 'components', 'adaptive-example.tsx'));
    expect(existsSync(path.join(dir, 'src', 'components', 'adaptive-example.tsx'))).toBe(true);
  });

  it('prefers an existing top-level components/ dir even when src/ exists', () => {
    mkdirSync(path.join(dir, 'src'));
    mkdirSync(path.join(dir, 'components'));
    const written = scaffoldExample(dir);
    expect(written).toBe(path.join(dir, 'components', 'adaptive-example.tsx'));
    expect(existsSync(path.join(dir, 'src', 'components'))).toBe(false);
  });

  it('never clobbers an existing example: returns null and leaves the file untouched', () => {
    mkdirSync(path.join(dir, 'components'));
    writeFileSync(path.join(dir, 'components', 'adaptive-example.tsx'), '// mine');
    expect(scaffoldExample(dir)).toBeNull();
    expect(readFileSync(path.join(dir, 'components', 'adaptive-example.tsx'), 'utf-8')).toBe('// mine');
  });
});
