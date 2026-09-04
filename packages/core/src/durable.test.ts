import { describe, expect, it } from 'vitest';
import { backoffDelayMs, classifyResponse } from './durable';

// Direct pins for the CONTRACTS.md §7 delivery table. queue.test.ts and
// goal-queue.test.ts exercise these through their transports; this file pins
// the classification boundaries themselves so a drifted edge (a 429 treated as
// terminal, a 4xx retried forever) fails here by name instead of surfacing as
// a flaky queue test.
describe('classifyResponse', () => {
  it('2xx is delivered', () => {
    expect(classifyResponse({ status: 200 })).toBe('delivered');
    expect(classifyResponse({ status: 202 })).toBe('delivered');
    expect(classifyResponse({ status: 299 })).toBe('delivered');
  });

  it('429 is retryable — rate limiting is transient, not a verdict on the payload', () => {
    expect(classifyResponse({ status: 429 })).toBe('retry');
  });

  it('4xx other than 429 is dropped — retrying a rejected body loops forever and starves the bucket', () => {
    expect(classifyResponse({ status: 400 })).toBe('dropped');
    expect(classifyResponse({ status: 401 })).toBe('dropped');
    expect(classifyResponse({ status: 403 })).toBe('dropped');
    expect(classifyResponse({ status: 404 })).toBe('dropped');
    expect(classifyResponse({ status: 499 })).toBe('dropped');
  });

  it('5xx is retryable', () => {
    expect(classifyResponse({ status: 500 })).toBe('retry');
    expect(classifyResponse({ status: 502 })).toBe('retry');
    expect(classifyResponse({ status: 503 })).toBe('retry');
  });

  it('an unrecognizable response (no ok, no status) is retryable, matching the original queue', () => {
    // Network-error shape: a caller that caught a thrown fetch has nothing to
    // hand over. Dropping here would turn every offline blip into data loss.
    expect(classifyResponse({})).toBe('retry');
    expect(classifyResponse({ ok: false })).toBe('retry');
  });

  it('ok is consulted BEFORE status — an {ok: true}-only stub is delivered', () => {
    // The SDK test suites stub fetch with responses that set only `ok`. If
    // status were checked first, every such stub would classify as retry and
    // the whole suite would spin on phantom failures.
    expect(classifyResponse({ ok: true })).toBe('delivered');
    // ok:true wins even against a status that would otherwise retry or drop —
    // it is the semantic check; status is the fallback, not a veto.
    expect(classifyResponse({ ok: true, status: 500 })).toBe('delivered');
    expect(classifyResponse({ ok: true, status: 400 })).toBe('delivered');
  });
});

describe('backoffDelayMs', () => {
  it('doubles from 2s and caps at 60s, exponent capped at 6', () => {
    // 2^6 s = 64s already exceeds the 60s cap — the exponent cap exists to stop
    // the shift overflowing on a long outage, not to set the ceiling.
    expect(backoffDelayMs(1)).toBe(2_000);
    expect(backoffDelayMs(2)).toBe(4_000);
    expect(backoffDelayMs(3)).toBe(8_000);
    expect(backoffDelayMs(4)).toBe(16_000);
    expect(backoffDelayMs(5)).toBe(32_000);
    expect(backoffDelayMs(6)).toBe(60_000);
    expect(backoffDelayMs(7)).toBe(60_000);
    expect(backoffDelayMs(1_000)).toBe(60_000);
  });
});
