import { describe, expect, it } from 'vitest';
import { signConnectState, verifyConnectState } from './connect-state.server';

// Same vector as apps/api/src/lib/shopify-connect-state.test.ts (the API
// verifies what this app signs).
const VECTOR = 'eyJzaG9wIjoieC5teXNob3BpZnkuY29tIiwiZXhwIjo0MTAyNDQ0ODAwMDAwLCJuIjoiZml4ZWQifQ.aKmetjZipcxl4DRFCFRQC0js1cuSG9EyQVnuJWbvnVw';

describe('connect state (audit H11)', () => {
  it('verifies the cross-app vector', () => {
    expect(verifyConnectState(VECTOR, 'vector-secret', 0)).toEqual({ shop: 'x.myshopify.com', exp: 4102444800000, n: 'fixed' });
  });
  it('round-trips, and expires after ten minutes', () => {
    const now = 1_000_000;
    const s = signConnectState('shop-1.myshopify.com', 'k', now);
    expect(verifyConnectState(s, 'k', now)?.shop).toBe('shop-1.myshopify.com');
    expect(verifyConnectState(s, 'k', now + 10 * 60 * 1000 + 1)).toBeNull();
    expect(verifyConnectState(s, 'other', now)).toBeNull();
  });
});
