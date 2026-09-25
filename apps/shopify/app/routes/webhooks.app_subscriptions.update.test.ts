import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticateWebhookAllowingExpiredToken } from '../lib/webhook-auth.server';
import { clearPlanIssue, getSettings, recordPlanIssue } from '../lib/settings.server';
import { syncPlan } from '../lib/plan-sync.server';
import { action } from './webhooks.app_subscriptions.update';

vi.mock('../lib/webhook-auth.server', () => ({ authenticateWebhookAllowingExpiredToken: vi.fn() }));
vi.mock('../lib/settings.server', () => ({ getSettings: vi.fn(), recordPlanIssue: vi.fn(), clearPlanIssue: vi.fn() }));
vi.mock('../lib/plan-sync.server', async (orig) => ({
  ...(await orig<typeof import('../lib/plan-sync.server')>()),
  syncPlan: vi.fn(),
}));

const auth = authenticateWebhookAllowingExpiredToken as unknown as ReturnType<typeof vi.fn>;
const settings = getSettings as unknown as ReturnType<typeof vi.fn>;
const drop = recordPlanIssue as unknown as ReturnType<typeof vi.fn>;
const clear = clearPlanIssue as unknown as ReturnType<typeof vi.fn>;
const sync = syncPlan as unknown as ReturnType<typeof vi.fn>;

const request = () => new Request('https://app.test/webhooks/app_subscriptions/update', { method: 'POST' });

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({
    shop: 'x.myshopify.com',
    topic: 'APP_SUBSCRIPTIONS_UPDATE',
    payload: { app_subscription: { name: 'Growth', status: 'ACTIVE', admin_graphql_api_id: 'gid://s/1', updated_at: '2026-09-25T10:00:00Z' } },
  });
  settings.mockResolvedValue({ secretKey: 'sk_test' });
});

describe('app_subscriptions/update', () => {
  // Review R8 M1: a purchase SentientUI refuses for good (a disconnected
  // store's 409) was acked and only logged — the merchant paid Shopify and
  // saw a healthy admin.
  it('acks a permanently refused plan change and records it for the admin banner', async () => {
    sync.mockResolvedValue('terminal');
    expect((await action({ request: request(), params: {}, context: {} } as never)).status).toBe(200);
    expect(drop).toHaveBeenCalledWith('x.myshopify.com', expect.stringContaining('A plan change (growth) was not applied'));
  });

  it('records a purchase the API refused, so the merchant learns the Shopify charge will not apply', async () => {
    sync.mockResolvedValue('refused');
    expect((await action({ request: request(), params: {}, context: {} } as never)).status).toBe(200);
    expect(drop).toHaveBeenCalledWith('x.myshopify.com', expect.stringContaining('was not applied: your SentientUI account is already billed another way'));
  });

  it('a retryable failure 500s and records nothing; a success records nothing', async () => {
    sync.mockResolvedValue(false);
    expect((await action({ request: request(), params: {}, context: {} } as never)).status).toBe(500);
    expect(clear).not.toHaveBeenCalled();
    sync.mockResolvedValue(true);
    expect((await action({ request: request(), params: {}, context: {} } as never)).status).toBe(200);
    expect(drop).not.toHaveBeenCalled();
    // Review R10 L1: an applied plan event is what clears the banner — not an order.
    expect(clear).toHaveBeenCalledWith('x.myshopify.com');
  });
});
