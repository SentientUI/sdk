import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { authenticate } from '../shopify.server';
import db from '../db.server';
import { action } from './webhooks.app.scopes_update';

vi.mock('../shopify.server', () => ({
  authenticate: { webhook: vi.fn() },
}));
vi.mock('../db.server', () => ({
  default: { session: { update: vi.fn() } },
}));

const webhook = authenticate.webhook as unknown as ReturnType<typeof vi.fn>;
const update = (db as unknown as { session: { update: ReturnType<typeof vi.fn> } }).session.update;

function run() {
  return action({
    request: new Request('https://app.test/webhooks', { method: 'POST' }),
    params: {},
    context: {},
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('webhooks.app.scopes_update', () => {
  it('writes the new scopes onto the session row and 200s', async () => {
    webhook.mockResolvedValue({
      shop: 'x.myshopify.com',
      topic: 'APP_SCOPES_UPDATE',
      session: { id: 'offline_x.myshopify.com' },
      payload: { current: ['read_orders', 'write_pixels'] },
    });
    const res = await run();
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'offline_x.myshopify.com' },
      data: { scope: 'read_orders,write_pixels' },
    });
  });

  it('a malformed payload (current not a string array) → ack and log, no write', async () => {
    // This was `payload.current as string[]` — an unchecked cast — so a
    // reshaped field in a newer payload version TypeError'd into a 500 and 48h
    // of retries that could never succeed.
    webhook.mockResolvedValue({
      shop: 'x.myshopify.com',
      topic: 'APP_SCOPES_UPDATE',
      session: { id: 'offline_x.myshopify.com' },
      payload: { current: 'read_orders' },
    });
    const res = await run();
    expect(res.status).toBe(200);
    expect(update).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not a string array'));
  });

  it('swallows P2025 — a concurrent app/uninstalled deleted the row; the scope of a gone install is moot', async () => {
    webhook.mockResolvedValue({
      shop: 'x.myshopify.com',
      topic: 'APP_SCOPES_UPDATE',
      session: { id: 'offline_x.myshopify.com' },
      payload: { current: ['read_orders'] },
    });
    update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('record not found', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );
    const res = await run();
    expect(res.status).toBe(200); // acking beats 500ing into retries against a row that will never come back
  });

  it('any other database error still propagates — only the uninstall race is expected', async () => {
    webhook.mockResolvedValue({
      shop: 'x.myshopify.com',
      topic: 'APP_SCOPES_UPDATE',
      session: { id: 'offline_x.myshopify.com' },
      payload: { current: ['read_orders'] },
    });
    update.mockRejectedValue(new Error('db down'));
    await expect(run()).rejects.toThrow('db down');
  });

  it('no session on the delivery → nothing to update, still 200', async () => {
    webhook.mockResolvedValue({
      shop: 'x.myshopify.com',
      topic: 'APP_SCOPES_UPDATE',
      session: undefined,
      payload: { current: ['read_orders'] },
    });
    expect((await run()).status).toBe(200);
    expect(update).not.toHaveBeenCalled();
  });
});
