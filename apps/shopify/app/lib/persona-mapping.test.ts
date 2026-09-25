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
  // Liquid's `app.metafields.config.*` (the theme embed) reads app-DATA
  // metafields — owned by the app installation. The shop-owned `$app:config`
  // write was invisible to it, so the storefront never applied the mapping.
  it('writes the mapping as an app-data metafield on the app installation', async () => {
    const gql = gqlMock([
      { data: { currentAppInstallation: { id: 'gid://shopify/AppInstallation/1' } } },
      { data: { metafieldsSet: { metafields: [{ id: 'gid://mf/1' }], userErrors: [] } } },
    ]);
    expect(await savePersonaTagMapping(gql, { vip: 'vip' })).toBe(true);
    const [query] = (gql as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(query)).toContain('currentAppInstallation');
    const [, opts] = (gql as ReturnType<typeof vi.fn>).mock.calls[1]!;
    const mfs = (opts as { variables: { metafields: Array<Record<string, string>> } }).variables.metafields;
    expect(mfs).toHaveLength(1);
    expect(mfs[0]!.ownerId).toBe('gid://shopify/AppInstallation/1');
    expect(mfs[0]!.namespace).toBe('config');
    expect(mfs[0]!.type).toBe('json');
    expect(JSON.parse(mfs[0]!.value)).toEqual({ vip: 'vip' });
  });

  it('also writes the pk_ the theme embed falls back to, so it is pasted once (audit H10)', async () => {
    const gql = gqlMock([
      { data: { currentAppInstallation: { id: 'gid://shopify/AppInstallation/1' } } },
      { data: { metafieldsSet: { metafields: [{ id: 'a' }, { id: 'b' }], userErrors: [] } } },
    ]);
    expect(await savePersonaTagMapping(gql, {}, 'pk_live_abc')).toBe(true);
    const [, opts] = (gql as ReturnType<typeof vi.fn>).mock.calls[1]!;
    const pk = (opts as { variables: { metafields: Array<Record<string, string>> } }).variables.metafields[1]!;
    expect(pk).toMatchObject({ namespace: 'config', key: 'publishable_key', type: 'single_line_text_field', value: 'pk_live_abc' });
  });
});
