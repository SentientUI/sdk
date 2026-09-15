import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadAdaptiveDecision } from './server.js';
import { pickDeterministicArm } from '@sentientui/policy';

const cookiesWith = (value: string | null) => ({
  get: (name: string) => (name === '_snt_uid' && value ? { value } : undefined),
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadAdaptiveDecision — keyless (development condition)', () => {
  it('never fetches and computes the decision via the local engine with the cookie session', async () => {
    const result = await loadAdaptiveDecision({
      cookies: cookiesWith('ssr-sess-1'),
      apiKey: '',
      baseUrl: 'https://api.example.com/v1',
      sections: ['hero', 'pricing', 'faq'],
      components: [{ id: 'hero_cta', variantIds: ['a', 'b'] }],
      slots: [{ id: 'hero', dims: { tone: ['calm', 'urgent'] } }],
    });
    expect(fetch).not.toHaveBeenCalled(); // short-circuits BEFORE any fetch — no timeout burn
    expect(result.sessionId).toBe('ssr-sess-1');
    // Nothing forced, nothing declared → unknown (was a session hash onto the
    // seeded personas, removed 2026-09-13), which keeps the authored order.
    const persona = 'unknown';
    expect(result.persona).toBe(persona);
    expect(result.confidence).toBe(0.5);
    expect(result.assignments.hero_cta).toBe(pickDeterministicArm('ssr-sess-1', 'hero_cta', ['a', 'b']));
    expect(result.slots.hero).toEqual({
      tone: pickDeterministicArm(`ssr-sess-1:${persona}`, 'hero.tone', ['calm', 'urgent']),
    });
    expect(result.layoutOrder).toEqual(['hero', 'pricing', 'faq']);
  });

  it('generates a session id when no cookie exists (ssrSessionId flow)', async () => {
    const result = await loadAdaptiveDecision({
      cookies: cookiesWith(null),
      apiKey: '',
      baseUrl: 'https://api.example.com/v1',
      sections: ['hero'],
    });
    expect(result.sessionId.length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
