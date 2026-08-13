import { describe, it, expect } from 'vitest';
import { grantConsent } from './index.js';

describe('grantConsent re-export', () => {
  // A React app wiring a cookie banner should not need @sentientui/core as a
  // direct dependency just to call this.
  it('is exported from the package root', () => {
    expect(typeof grantConsent).toBe('function');
  });

  it('no-ops during SSR rather than throwing', () => {
    expect(() => grantConsent('pk_test_ssr_noop')).not.toThrow();
  });
});
