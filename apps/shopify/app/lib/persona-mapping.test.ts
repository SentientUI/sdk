import { describe, expect, it, vi } from 'vitest';
import { mappingToText, parseTagMapping, savePersonaTagMapping } from './persona-mapping.server';
import { ensureWebPixel } from './pixel.server';

describe('parseTagMapping', () => {
  it('parses tag = persona lines, lowercasing the persona key', () => {
    const r = parseTagMapping('wholesale = wholesale\n VIP = Vip \n\n');
    expect(r).toEqual({ ok: true, mapping: { wholesale: 'wholesale', VIP: 'vip' } });
  });

  it('round-trips through mappingToText', () => {
    const r = parseTagMapping('a = one\nb tag = two');
    if (!r.ok) throw new Error('parse failed');
    expect(parseTagMapping(mappingToText(r.mapping))).toEqual(r);
  });

  it('reports the offending line instead of silently dropping it', () => {
    const noEq = parseTagMapping('wholesale wholesale');
    expect(noEq.ok).toBe(false);
    const badKey = parseTagMapping('vip = Not A Key!');
    expect(badKey.ok).toBe(false);
    expect((badKey as { error: string }).error).toContain('persona keys');
  });

  it('an empty box is a valid empty mapping', () => {
    expect(parseTagMapping('')).toEqual({ ok: true, mapping: {} });
  });
});

type GqlResponse = { json(): Promise<unknown> };
function gqlMock(responses: unknown[]): (q: string, o?: unknown) => Promise<GqlResponse> {
  const queue = [...responses];
  return vi.fn(async () => ({ json: async () => queue.shift() }));
}

describe('ensureWebPixel', () => {
  it('creates the pixel with the publishable key in settings', async () => {
    const gql = gqlMock([{ data: { webPixelCreate: { webPixel: { id: 'gid://1' }, userErrors: [] } } }]);
    expect((await ensureWebPixel(gql, 'pk_test')).ok).toBe(true);
    const [, opts] = (gql as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const settings = JSON.parse((opts as { variables: { webPixel: { settings: string } } }).variables.webPixel.settings);
    expect(settings.publishableKey).toBe('pk_test');
  });

  it('TAKEN → looks up the existing pixel and updates it in place', async () => {
    const gql = gqlMock([
      { data: { webPixelCreate: { webPixel: null, userErrors: [{ code: 'TAKEN', message: 'exists' }] } } },
      { data: { webPixel: { id: 'gid://existing' } } },
      { data: { webPixelUpdate: { webPixel: { id: 'gid://existing' }, userErrors: [] } } },
    ]);
    expect((await ensureWebPixel(gql, 'pk_test')).ok).toBe(true);
    expect((gql as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it('any other error → false, never a throw (fail-soft on settings save)', async () => {
    const gql = gqlMock([{ data: { webPixelCreate: { webPixel: null, userErrors: [{ code: 'INVALID_SETTINGS', message: 'no' }] } } }]);
    const r = await ensureWebPixel(gql, 'pk_test');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('INVALID_SETTINGS');
  });
});

describe('savePersonaTagMapping', () => {
  it('writes the mapping as an app-owned shop metafield', async () => {
    const gql = gqlMock([
      { data: { shop: { id: 'gid://shopify/Shop/1' } } },
      { data: { metafieldsSet: { metafields: [{ id: 'gid://mf/1' }], userErrors: [] } } },
    ]);
    expect(await savePersonaTagMapping(gql, { vip: 'vip' })).toBe(true);
    const [, opts] = (gql as ReturnType<typeof vi.fn>).mock.calls[1]!;
    const mf = (opts as { variables: { metafields: Array<Record<string, string>> } }).variables.metafields[0]!;
    expect(mf.namespace).toBe('$app:config');
    expect(mf.type).toBe('json');
    expect(JSON.parse(mf.value)).toEqual({ vip: 'vip' });
  });
});
