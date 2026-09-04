import { describe, expect, it, vi } from 'vitest';
import { mappingToText, parseTagMapping, savePersonaTagMapping } from './persona-mapping.server';

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

// The ensureWebPixel suite that used to live here moved to its rightful home,
// pixel.server.test.ts, alongside the healWebPixelApiBase coverage.

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
