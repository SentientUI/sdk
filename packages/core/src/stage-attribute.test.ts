import { afterEach, describe, expect, it, vi } from 'vitest';
import { exposedStage, setStageAttribute, STAGE_ATTRIBUTE } from './stage-attribute.js';
import { init } from './index.js';

afterEach(() => {
  document.documentElement.removeAttribute(STAGE_ATTRIBUTE);
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('exposedStage', () => {
  it('coarsens customer and lapsed to `returning` by default', () => {
    expect(exposedStage('customer', true)).toBe('returning');
    expect(exposedStage('lapsed', true)).toBe('returning');
    for (const s of ['new', 'browsing', 'carted']) expect(exposedStage(s, true)).toBe(s);
  });

  it("exposes them as they are only with 'detailed'", () => {
    expect(exposedStage('customer', 'detailed')).toBe('customer');
    expect(exposedStage('lapsed', 'detailed')).toBe('lapsed');
  });

  it('never exposes an arrival class or anything outside the stage set, whatever the server sends', () => {
    for (const v of ['cart_recovery', 'product_ad', 'offer', '', 'x"><img>', 42, null, undefined]) {
      expect(exposedStage(v, 'detailed')).toBeNull();
    }
  });

  it('passes an already-coarsened `returning` (a snapshot value) through in either mode', () => {
    expect(exposedStage('returning', true)).toBe('returning');
    expect(exposedStage('returning', 'detailed')).toBe('returning');
  });

  it('is off unless opted in', () => {
    expect(exposedStage('carted', undefined)).toBeNull();
    expect(exposedStage('carted', false)).toBeNull();
  });

  it('setStageAttribute writes, overwrites and removes', () => {
    setStageAttribute('new');
    setStageAttribute('carted');
    expect(document.documentElement.getAttribute(STAGE_ATTRIBUTE)).toBe('carted');
    setStageAttribute(null);
    expect(document.documentElement.hasAttribute(STAGE_ATTRIBUTE)).toBe(false);
  });
});

describe('init({ stageAttributes }) — after decide', () => {
  function stubDecide(json: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => (String(input).endsWith('/decide') ? json : {}),
      } as Response),
    ));
  }
  const DECIDE = { layoutOrder: null, assignments: {}, slots: {}, persona: 'unknown', confidence: 0 };
  const snap = () => JSON.parse(localStorage.getItem('_snt_snap:pk_test_stage') ?? 'null') as Record<string, unknown> | null;

  it('writes the coarse stage to <html> and only that value to the snapshot', async () => {
    stubDecide({ ...DECIDE, stage: 'customer', context: 'cart_recovery' });
    const client = init({ apiKey: 'pk_test_stage', ingestUrl: 'https://api.example.com/v1/events', stageAttributes: true });
    const outcome = await client.decide({ sections: ['a', 'b'] });
    expect(outcome?.stage).toBe('customer');
    expect(outcome?.context).toBe('cart_recovery');
    expect(document.documentElement.getAttribute(STAGE_ATTRIBUTE)).toBe('returning');
    expect(snap()?.stage).toBe('returning');
    // The context (an arrival class here) never reaches the page or storage.
    expect(JSON.stringify(snap())).not.toContain('cart_recovery');
    client.destroy();
  });

  it('a decide without a stage (control group, stages off) removes a stale pre-paint value', async () => {
    document.documentElement.setAttribute(STAGE_ATTRIBUTE, 'carted');
    stubDecide(DECIDE);
    const client = init({ apiKey: 'pk_test_stage', ingestUrl: 'https://api.example.com/v1/events', stageAttributes: 'detailed' });
    await client.decide({ sections: ['a', 'b'] });
    expect(document.documentElement.hasAttribute(STAGE_ATTRIBUTE)).toBe(false);
    expect(snap()).not.toHaveProperty('stage');
    client.destroy();
  });

  it('without the option it touches neither the page nor the snapshot', async () => {
    document.documentElement.setAttribute(STAGE_ATTRIBUTE, 'merchant-owned');
    stubDecide({ ...DECIDE, stage: 'carted' });
    const client = init({ apiKey: 'pk_test_stage', ingestUrl: 'https://api.example.com/v1/events' });
    await client.decide({ sections: ['a', 'b'] });
    expect(document.documentElement.getAttribute(STAGE_ATTRIBUTE)).toBe('merchant-owned');
    expect(snap()).not.toHaveProperty('stage');
    client.destroy();
  });
});
