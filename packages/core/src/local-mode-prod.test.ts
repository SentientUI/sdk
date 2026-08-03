import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { init } from './index.js';
import { __resetLocalModeLogGuards, PROD_KEYLESS_ERROR } from './local-mode.js';

vi.mock('@sentientui/core/local', () => import('./index-local-stub.js'));

beforeEach(() => {
  document.cookie = '_snt_uid=; max-age=0; path=/';
  localStorage.clear();
  __resetLocalModeLogGuards();
  vi.stubGlobal('fetch', vi.fn());
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('init() keyless — production condition (stub resolves)', () => {
  it('degrades to a no-op client with exactly one console.error per load', async () => {
    const client = init({ apiKey: '', context: 'landing' });
    expect(await client.decide({ slots: [{ id: 'hero', dims: { tone: ['calm', 'urgent'] } }] })).toBeNull();
    expect(client.getSlotResult('hero')).toBeNull();
    expect(await client.decide({})).toBeNull(); // second decide — still one error
    expect(fetch).not.toHaveBeenCalled();
    const errors = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => c[0] === PROD_KEYLESS_ERROR);
    expect(errors).toHaveLength(1);
  });
});
