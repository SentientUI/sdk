import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureWebPixel, healWebPixelApiBase } from './pixel.server';

type GqlResponse = { json(): Promise<unknown> };
// An Error in the queue is THROWN, matching the real admin client: it raises
// GraphqlQueryError for top-level GraphQL errors instead of resolving them.
function gqlMock(responses: unknown[]): (q: string, o?: unknown) => Promise<GqlResponse> {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return { json: async () => next };
  });
}

afterEach(() => {
  delete process.env.SENTIENT_API_URL;
});

describe('ensureWebPixel', () => {
  // When the app has no pixel yet the lookup fails with a top-level GraphQL
  // error, which the admin client THROWS ("No web pixel was found for this
  // app."). That throw must read as "create one", not as a failure — treating
  // it as fatal broke activation on every fresh store while dev stores (pixel
  // already present) kept passing, which is exactly the App Store reviewer
  // environment (rejection 2026-09-09, 4.5.5).
  const NO_PIXEL = () => new Error('No web pixel was found for this app.');

  it('no pixel yet (thrown lookup error) → creates it with the publishable key in settings', async () => {
    const gql = gqlMock([
      NO_PIXEL(),
      { data: { webPixelCreate: { webPixel: { id: 'gid://1' }, userErrors: [] } } },
    ]);
    expect((await ensureWebPixel(gql, 'pk_test')).ok).toBe(true);
    const [, opts] = (gql as ReturnType<typeof vi.fn>).mock.calls[1]!;
    const settings = JSON.parse((opts as { variables: { webPixel: { settings: string } } }).variables.webPixel.settings);
    expect(settings.publishableKey).toBe('pk_test');
  });

  it('a lookup answering resolved top-level errors (non-throwing client) also reads as create', async () => {
    const gql = gqlMock([
      { errors: [{ message: 'No web pixel was found' }] },
      { data: { webPixelCreate: { webPixel: { id: 'gid://1' }, userErrors: [] } } },
    ]);
    expect((await ensureWebPixel(gql, 'pk_test')).ok).toBe(true);
  });

  it('re-save → updates the existing pixel without firing the doomed create', async () => {
    // Creating first fired a guaranteed TAKEN error on every re-save; the
    // lookup-first order must go straight to the update.
    const gql = gqlMock([
      { data: { webPixel: { id: 'gid://existing' } } },
      { data: { webPixelUpdate: { webPixel: { id: 'gid://existing' }, userErrors: [] } } },
    ]);
    expect((await ensureWebPixel(gql, 'pk_test')).ok).toBe(true);
    expect((gql as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('TAKEN despite the lookup (concurrent save) → re-queries and updates in place', async () => {
    const gql = gqlMock([
      NO_PIXEL(),
      { data: { webPixelCreate: { webPixel: null, userErrors: [{ code: 'TAKEN', message: 'exists' }] } } },
      { data: { webPixel: { id: 'gid://existing' } } },
      { data: { webPixelUpdate: { webPixel: { id: 'gid://existing' }, userErrors: [] } } },
    ]);
    expect((await ensureWebPixel(gql, 'pk_test')).ok).toBe(true);
    expect((gql as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  });

  it('any other error → false, never a throw (fail-soft on settings save)', async () => {
    const gql = gqlMock([
      NO_PIXEL(),
      { data: { webPixelCreate: { webPixel: null, userErrors: [{ code: 'INVALID_SETTINGS', message: 'no' }] } } },
    ]);
    const r = await ensureWebPixel(gql, 'pk_test');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('INVALID_SETTINGS');
  });

  it('a real failure (missing scope) still surfaces — via the create, not the lookup', async () => {
    // The lookup swallows its own throw, so a broken shop reaches the create;
    // THAT error is the one the merchant banner must carry.
    const gql = gqlMock([
      new Error('Access denied for webPixel'),
      new Error('Access denied for webPixelCreate'),
    ]);
    const r = await ensureWebPixel(gql, 'pk_test');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Access denied for webPixelCreate');
  });
});

describe('healWebPixelApiBase — the SHOP-10 stale-apiBase healer', () => {
  // ensureWebPixel snapshots SENTIENT_API_URL into the pixel settings at save
  // time, so an env change on the app server used to require EVERY merchant to
  // re-save their keys before checkout events pointed at the new API.

  it('rewrites a pixel whose stored apiBase differs from the current env', async () => {
    process.env.SENTIENT_API_URL = 'https://api.new';
    const gql = gqlMock([
      // The loader's read: pixel exists, but its baked-in apiBase is stale.
      { data: { webPixel: { id: 'gid://1', settings: JSON.stringify({ publishableKey: 'pk_test', apiBase: 'https://api.old' }) } } },
      // ensureWebPixel's own lookup-first path, then the update.
      { data: { webPixel: { id: 'gid://1' } } },
      { data: { webPixelUpdate: { webPixel: { id: 'gid://1' }, userErrors: [] } } },
    ]);
    await healWebPixelApiBase(gql, 'pk_test');
    const calls = (gql as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(3);
    const settings = JSON.parse(
      (calls[2]![1] as { variables: { webPixel: { settings: string } } }).variables.webPixel.settings,
    );
    expect(settings.apiBase).toBe('https://api.new');
    expect(settings.publishableKey).toBe('pk_test');
  });

  it('writes nothing when the stored apiBase already matches — one read per admin visit', async () => {
    process.env.SENTIENT_API_URL = 'https://api.current';
    const gql = gqlMock([
      { data: { webPixel: { id: 'gid://1', settings: JSON.stringify({ publishableKey: 'pk_test', apiBase: 'https://api.current' }) } } },
    ]);
    await healWebPixelApiBase(gql, 'pk_test');
    expect((gql as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('no pixel yet (thrown lookup error) → does NOT create one (creating here would race the save path)', async () => {
    const gql = gqlMock([new Error('No web pixel was found for this app.')]);
    await healWebPixelApiBase(gql, 'pk_test');
    expect((gql as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('unparseable stored settings read as stale and get rewritten', async () => {
    // A corrupt settings blob means the pixel is pointing who-knows-where;
    // treating it as current would leave it broken forever.
    process.env.SENTIENT_API_URL = 'https://api.new';
    const gql = gqlMock([
      { data: { webPixel: { id: 'gid://1', settings: 'not json {' } } },
      { data: { webPixel: { id: 'gid://1' } } },
      { data: { webPixelUpdate: { webPixel: { id: 'gid://1' }, userErrors: [] } } },
    ]);
    await healWebPixelApiBase(gql, 'pk_test');
    expect((gql as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it('a throwing graphql client resolves silently — a pixel hiccup must never block the settings screen', async () => {
    const gql = vi.fn(async () => { throw new Error('admin API down'); });
    await expect(healWebPixelApiBase(gql, 'pk_test')).resolves.toBeUndefined();
  });
});
