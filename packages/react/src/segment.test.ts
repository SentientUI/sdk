import { describe, it, expect } from 'vitest';
import { detectSegment } from './segment.js';
import { deriveSessionSegment } from '@sentientui/core';

describe('segment (deprecated re-export)', () => {
  it('re-exports core deriveSessionSegment as detectSegment', () => {
    expect(detectSegment).toBe(deriveSessionSegment);
  });

  it('produces the same segment string as the core function', () => {
    const args = {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      referer: 'https://www.google.com/',
    };
    expect(detectSegment(args)).toBe(deriveSessionSegment(args));
    // Shape is `<device>:<source>`.
    expect(detectSegment(args)).toMatch(/^[^:]+:[^:]+$/);
  });
});
