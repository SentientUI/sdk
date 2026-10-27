import { describe, it, expect, vi, beforeEach } from 'vitest';
import { init } from './index';

// Verified identify: the server-signed userHash must ride the identify upsert,
// or the API can only ever record an unverified binding.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

async function identifyBody(hash?: string): Promise<Record<string, unknown>> {
  const client = init({ apiKey: 'pk_test_ident1', ingestUrl: 'https://api.example.com/v1/events', context: 'saas', consent: true });
  client.identify('user_42', hash === undefined ? undefined : { userHash: hash });
  await vi.waitFor(() => {
    const call = vi.mocked(fetch).mock.calls.find(([, init]) =>
      String((init as RequestInit | undefined)?.body ?? '').includes('"userId":"user_42"'));
    if (!call) throw new Error('identify not sent yet');
  });
  const call = vi.mocked(fetch).mock.calls.find(([, init]) =>
    String((init as RequestInit | undefined)?.body ?? '').includes('"userId":"user_42"'))!;
  client.dispose?.();
  return JSON.parse(String((call[1] as RequestInit).body));
}

describe('identify()', () => {
  it('sends the userHash with the user id', async () => {
    expect(await identifyBody('v1.abc')).toMatchObject({ userId: 'user_42', userHash: 'v1.abc' });
  });

  it('without a hash sends no userHash (an unverified identify)', async () => {
    expect(await identifyBody()).not.toHaveProperty('userHash');
  });
});
