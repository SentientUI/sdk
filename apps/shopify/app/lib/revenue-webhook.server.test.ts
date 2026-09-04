import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardWebhook } from './forward';
import {
  getSettings,
  recordForwardSuccess,
  recordTerminalDrop,
  sentientApiUrl,
} from './settings.server';
import { handleRevenueWebhook } from './revenue-webhook.server';

// Every dollar of Shopify revenue flows through this orchestration. The
// forwarding core beneath it has its own suite (forward.test.ts); this one
// pins what the orchestrator does AROUND it — which health record gets
// written for which outcome, and what Shopify is told to do next.

vi.mock('./forward', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./forward')>()),
  forwardWebhook: vi.fn(),
}));
vi.mock('./settings.server', () => ({
  getSettings: vi.fn(),
  recordForwardSuccess: vi.fn(),
  recordTerminalDrop: vi.fn(),
  sentientApiUrl: vi.fn(() => 'https://api.test'),
}));

const mockForward = forwardWebhook as unknown as ReturnType<typeof vi.fn>;
const mockGetSettings = getSettings as unknown as ReturnType<typeof vi.fn>;
const mockRecordSuccess = recordForwardSuccess as unknown as ReturnType<typeof vi.fn>;
const mockRecordDrop = recordTerminalDrop as unknown as ReturnType<typeof vi.fn>;

const SETTINGS = {
  publishableKey: 'pk_test',
  secretKey: 'sk_test',
  lastForwardAt: null,
  lastDropAt: null,
  lastDropReason: null,
};
const ORDER = { id: 987, total_price: '42.50', currency: 'EUR' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSettings.mockResolvedValue(SETTINGS);
  mockForward.mockResolvedValue({ status: 200, outcome: 'forwarded' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('handleRevenueWebhook — orchestration', () => {
  it('a decrypt failure → 500, deliberately: Shopify retries within its 48h contract', async () => {
    // The stored sk_ is fine — the operator lost/rotated SETTINGS_ENCRYPTION_KEY.
    // Acking 200 here would silently drop revenue that a restored key can still
    // deliver; the 500 keeps the retries alive while the runbook is followed.
    mockGetSettings.mockRejectedValue(new Error('bad decrypt'));
    const res = await handleRevenueWebhook('x.myshopify.com', 'ORDERS_PAID', ORDER);
    expect(res.status).toBe(500);
    expect(mockForward).not.toHaveBeenCalled(); // never forward with an unreadable key
    // The log must name the real cause — this used to be an anonymous 500 storm.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('SETTINGS_ENCRYPTION_KEY'));
  });

  it('passes the decrypted sk_, topic, payload and API url through to the forwarder', async () => {
    await handleRevenueWebhook('x.myshopify.com', 'ORDERS_PAID', ORDER);
    expect(mockForward).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'ORDERS_PAID',
        payload: ORDER,
        secretKey: 'sk_test',
        apiUrl: 'https://api.test',
      }),
    );
    expect(sentientApiUrl).toHaveBeenCalled();
  });

  it('outcome forwarded → records the success (the drop banner\'s all-clear) and answers 200', async () => {
    const res = await handleRevenueWebhook('x.myshopify.com', 'ORDERS_PAID', ORDER);
    expect(res.status).toBe(200);
    expect(mockRecordSuccess).toHaveBeenCalledWith('x.myshopify.com', SETTINGS);
    expect(mockRecordDrop).not.toHaveBeenCalled();
  });

  it('a terminal drop → recordTerminalDrop with the reason, and NOT recordForwardSuccess', async () => {
    // Conflating dropped with forwarded would let a dropped order mark the
    // shop's webhook health as fine — the banner would never show.
    mockForward.mockImplementation(async (opts: { onTerminal?: (i: unknown) => Promise<void> }) => {
      await opts.onTerminal?.({ status: 401, path: '/v1/conversions', body: 'rotated key' });
      return { status: 200, outcome: 'dropped' };
    });
    const res = await handleRevenueWebhook('x.myshopify.com', 'ORDERS_PAID', ORDER);
    expect(res.status).toBe(200); // acked — retrying a 401 cannot help
    expect(mockRecordDrop).toHaveBeenCalledWith('x.myshopify.com', '401 /v1/conversions rotated key');
    expect(mockRecordSuccess).not.toHaveBeenCalled();
  });

  it('a non-terminal failure → 500 (retry), and neither health record is written', async () => {
    // A transient 5xx is neither a delivery nor an abandonment: lastForwardAt
    // must stay old (nothing arrived) and lastDropAt must stay unset (Shopify
    // is still trying).
    mockForward.mockResolvedValue({ status: 500, outcome: 'retry' });
    const res = await handleRevenueWebhook('x.myshopify.com', 'ORDERS_PAID', ORDER);
    expect(res.status).toBe(500);
    expect(mockRecordSuccess).not.toHaveBeenCalled();
    expect(mockRecordDrop).not.toHaveBeenCalled();
  });

  it('an unconfigured shop (no settings row) forwards null and records nothing', async () => {
    // forwardWebhook turns a null sk_ into a 200 skip; the orchestrator must
    // not invent a success record for a shop that delivered nothing.
    mockGetSettings.mockResolvedValue(null);
    mockForward.mockResolvedValue({ status: 200, outcome: 'skipped' });
    const res = await handleRevenueWebhook('x.myshopify.com', 'ORDERS_PAID', ORDER);
    expect(res.status).toBe(200);
    expect(mockForward).toHaveBeenCalledWith(expect.objectContaining({ secretKey: null }));
    expect(mockRecordSuccess).not.toHaveBeenCalled();
  });
});
