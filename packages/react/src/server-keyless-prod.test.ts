import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadAdaptiveDecision } from './server.js';

vi.mock('@sentientui/core/local', () =>
  import('../../core/src/index-local-stub.js' as string),
);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('loadAdaptiveDecision — keyless (production condition)', () => {
  it('returns defaults with one console.error and no fetch', async () => {
    const result = await loadAdaptiveDecision({
      cookies: { get: () => undefined },
      apiKey: '',
      baseUrl: 'https://api.example.com/v1',
      sections: ['hero', 'pricing'],
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.layoutOrder).toEqual(['hero', 'pricing']);
    expect(result.assignments).toEqual({});
    expect(result.persona).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
