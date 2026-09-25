import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The save action's key handling (reviews R9 H1, R10-E): a pasted key is
// provisioned BEFORE it is saved, and replacing stored keys needs the API to
// confirm the store is live on the new key's project — a disconnected or
// moved-away answer, a timed-out provision and an answer without a binding
// all keep the current keys.

vi.mock('../shopify.server', () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: 'save-test.myshopify.com' }, admin: { graphql: vi.fn() }, redirect: vi.fn() })) },
}));
vi.mock('../lib/settings.server', () => ({
  checkStorefrontOrigin: vi.fn(),
  getSettings: vi.fn(async () => ({ shop: 'save-test.myshopify.com', publishableKey: 'pk_live_B', secretKey: 'sk_live_B_current' })),
  provisionSentient: vi.fn(),
  saveSettings: vi.fn(async () => undefined),
  getPendingConnect: vi.fn(),
  deletePendingConnect: vi.fn(),
  revokeConnectPair: vi.fn(async () => undefined),
  confirmPendingConnect: vi.fn(),
}));
vi.mock('../lib/plan-sync.server', () => ({
  observeSubscription: vi.fn(async () => ({ event: null, observed: 'none' })),
  reconcilePlan: vi.fn(async () => undefined),
}));
vi.mock('../lib/pixel.server', () => ({ ensureWebPixel: vi.fn(async () => ({ ok: true })), healWebPixelApiBase: vi.fn() }));
vi.mock('../lib/persona-mapping.server', async (orig) => ({
  ...(await orig<typeof import('../lib/persona-mapping.server')>()),
  savePersonaTagMapping: vi.fn(async () => true),
}));
vi.mock('../lib/results.server', () => ({ describeResult: vi.fn(), fetchLiftSummary: vi.fn() }));

import { provisionSentient, saveSettings } from '../lib/settings.server';
import { action } from './app._index';

const prov = provisionSentient as unknown as ReturnType<typeof vi.fn>;
const save = saveSettings as unknown as ReturnType<typeof vi.fn>;

function paste() {
  const body = new URLSearchParams({ intent: 'save', publishableKey: 'pk_live_A_old', secretKey: 'sk_live_A_old', mappingText: '' });
  return action({ request: new Request('https://app.test/app?index', { method: 'POST', body }), params: {}, context: {} } as never);
}

beforeEach(() => vi.clearAllMocks());

const ORIGINAL_SECRET = process.env.SHOPIFY_CONNECTOR_SECRET;
beforeEach(() => { process.env.SHOPIFY_CONNECTOR_SECRET = 'shared'; });
afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.SHOPIFY_CONNECTOR_SECRET;
  else process.env.SHOPIFY_CONNECTOR_SECRET = ORIGINAL_SECRET;
});

describe('save action — replacing stored keys', () => {
  it('a disconnected or moved-away answer refuses the pasted key', async () => {
    prov.mockResolvedValue({ ok: true, binding: 'disconnected' });
    await paste();
    prov.mockResolvedValue({ ok: true, binding: 'detached' });
    await paste();
    expect(save).not.toHaveBeenCalled();
  });
  it('a provision that timed out keeps the current keys', async () => {
    prov.mockResolvedValue({ ok: false, binding: null });
    await paste();
    expect(save).not.toHaveBeenCalled();
  });
  it('an answer without a binding keeps the current keys', async () => {
    prov.mockResolvedValue({ ok: true, binding: null });
    await paste();
    expect(save).not.toHaveBeenCalled();
  });
  it('a live answer saves the pasted key', async () => {
    prov.mockResolvedValue({ ok: true, binding: 'live' });
    await paste();
    expect(save).toHaveBeenCalledWith('save-test.myshopify.com', 'pk_live_A_old', 'sk_live_A_old');
  });
});

describe('save action — first install', () => {
  it('stays fail-soft: a timed-out provision still saves the first keys', async () => {
    const { getSettings } = await import('../lib/settings.server');
    vi.mocked(getSettings).mockResolvedValueOnce(null);
    prov.mockResolvedValue({ ok: false, binding: null });
    await paste();
    expect(save).toHaveBeenCalled();
  });
});
