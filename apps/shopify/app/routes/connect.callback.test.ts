import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.server', () => ({ default: { session: { findFirst: vi.fn() } } }));
vi.mock('../lib/settings.server', () => ({ savePendingConnect: vi.fn() }));

import db from '../db.server';
import { savePendingConnect } from '../lib/settings.server';
import { signConnectState } from '../lib/connect-state.server';
import { action } from './connect.callback';

const SECRET = 'shared';
const findFirst = (db as unknown as { session: { findFirst: ReturnType<typeof vi.fn> } }).session.findFirst;
const save = savePendingConnect as unknown as ReturnType<typeof vi.fn>;

function call(body: unknown, secret: string | null = SECRET) {
  return action({
    request: new Request('https://app.test/connect/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret === null ? {} : { 'x-connector-secret': secret }) },
      body: JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as never);
}
const keys = { publishableKey: 'pk_live_a', secretKey: 'sk_live_b', projectId: 'p1', projectName: 'Store site' };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_CONNECTOR_SECRET = SECRET;
  process.env.SHOPIFY_API_KEY = 'client-id';
  findFirst.mockResolvedValue({ id: 's1' });
});
afterEach(() => {
  delete process.env.SHOPIFY_CONNECTOR_SECRET;
  delete process.env.SHOPIFY_API_KEY;
});

describe('connect/callback (audit H11)', () => {
  it('HOLDS the delivered keys as a pending connection for the signed shop — nothing is applied yet', async () => {
    const res = await call({ state: signConnectState('x.myshopify.com', SECRET), ...keys });
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledWith('x.myshopify.com', keys);
    expect(await res.json()).toMatchObject({ returnUrl: 'https://x.myshopify.com/admin/apps/client-id' });
  });

  it('refuses without the connector secret, with a forged or expired state, or odd keys', async () => {
    expect((await call({ state: signConnectState('x.myshopify.com', SECRET), ...keys }, null)).status).toBe(403);
    expect((await call({ state: signConnectState('x.myshopify.com', 'other'), ...keys })).status).toBe(400);
    expect((await call({ state: signConnectState('x.myshopify.com', SECRET, Date.now() - 11 * 60 * 1000), ...keys })).status).toBe(400);
    expect((await call({ state: signConnectState('x.myshopify.com', SECRET), ...keys, secretKey: 'pk_oops' })).status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a shop that is not installed — there is no admin to confirm in', async () => {
    findFirst.mockResolvedValue(null);
    expect((await call({ state: signConnectState('x.myshopify.com', SECRET), ...keys })).status).toBe(404);
    expect(save).not.toHaveBeenCalled();
  });
});
