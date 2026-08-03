import { describe, it, expect } from 'vitest';
import { isPublishableKey, warnIfNotPublishableKey, assertPublishableKey } from './validate-key.js';

describe('isPublishableKey', () => {
  it('accepts pk_ keys, rejects everything else', () => {
    expect(isPublishableKey('pk_live_abc')).toBe(true);
    expect(isPublishableKey('sk_live_abc')).toBe(false);
    expect(isPublishableKey('abc')).toBe(false);
  });
});

describe('warnIfNotPublishableKey', () => {
  it('stays silent for an undefined key (local mode)', () => {
    const lines: string[] = [];
    expect(warnIfNotPublishableKey(undefined, (l) => lines.push(l))).toBe(false);
    expect(lines).toEqual([]);
  });

  it('stays silent for a publishable pk_ key', () => {
    const lines: string[] = [];
    expect(warnIfNotPublishableKey('pk_live_abc', (l) => lines.push(l))).toBe(false);
    expect(lines).toEqual([]);
  });

  it('warns loudly for a secret sk_ key', () => {
    const lines: string[] = [];
    expect(warnIfNotPublishableKey('sk_live_secret', (l) => lines.push(l))).toBe(true);
    const out = lines.join('\n');
    expect(out).toMatch(/SECURITY WARNING/);
    expect(out).toMatch(/secret server key/i);
    // Never echoes the full secret.
    expect(out).not.toContain('sk_live_secret');
  });

  it('warns for any non-pk_ key', () => {
    const lines: string[] = [];
    expect(warnIfNotPublishableKey('garbage', (l) => lines.push(l))).toBe(true);
    expect(lines.join('\n')).toMatch(/publishable pk_/);
  });
});

describe('assertPublishableKey', () => {
  it('is a no-op for an undefined key (local mode)', () => {
    const lines: string[] = [];
    expect(() => assertPublishableKey(undefined, (l) => lines.push(l))).not.toThrow();
    expect(lines).toEqual([]);
  });

  it('is a no-op for a publishable pk_ key', () => {
    const lines: string[] = [];
    expect(() => assertPublishableKey('pk_live_abc', (l) => lines.push(l))).not.toThrow();
    expect(lines).toEqual([]);
  });

  it('throws (with the warning emitted) for a secret sk_ key', () => {
    const lines: string[] = [];
    expect(() => assertPublishableKey('sk_live_secret', (l) => lines.push(l))).toThrow(/publishable pk_/i);
    const out = lines.join('\n');
    expect(out).toMatch(/SECURITY WARNING/);
    expect(out).not.toContain('sk_live_secret');
  });

  it('throws for any non-pk_ key', () => {
    expect(() => assertPublishableKey('garbage', () => {})).toThrow(/publishable pk_/i);
  });
});
