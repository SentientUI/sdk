import { describe, expect, it, beforeEach } from 'vitest';
import { setVariantOverride, clearVariantOverride, getOverrides } from './devtools-overrides';

describe('devtools-overrides', () => {
  beforeEach(() => {
    (window as unknown as { __sentient_overrides?: unknown }).__sentient_overrides = undefined;
  });

  it('sets and clears overrides on window.__sentient_overrides', () => {
    setVariantOverride('hero', 'b');
    expect(getOverrides()).toEqual({ hero: 'b' });
    expect((window as unknown as { __sentient_overrides: Record<string, string> }).__sentient_overrides.hero).toBe('b');
    clearVariantOverride('hero');
    expect(getOverrides()).toEqual({});
  });
});
