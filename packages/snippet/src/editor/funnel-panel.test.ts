import { describe, expect, it } from 'vitest';
import {
  buildDraftPayload, deriveFunnelId, funnelSummaryLine, stepOptions, toggleStepSelection,
  type EditorFunnel,
} from './funnel-panel';

const funnel: EditorFunnel = {
  funnel_id: 'checkout',
  display_name: 'Checkout',
  status: 'draft',
  steps: [
    { step_index: 0, goal_id: 'add_to_cart' },
    { step_index: 1, goal_id: 'purchase' },
  ],
};

describe('funnelSummaryLine', () => {
  it('shows name, step count, and non-active status', () => {
    expect(funnelSummaryLine(funnel)).toBe('Checkout — 2 steps (draft)');
    expect(funnelSummaryLine({ ...funnel, status: 'active' })).toBe('Checkout — 2 steps');
    expect(funnelSummaryLine({ ...funnel, steps: funnel.steps.slice(0, 1) })).toBe('Checkout — 1 step (draft)');
  });
});

describe('stepOptions', () => {
  it('labels steps 1-based with goal display names, falling back to ids', () => {
    const names = new Map([['add_to_cart', 'Added to cart']]);
    expect(stepOptions(funnel, names)).toEqual([
      { value: 0, label: '1. Added to cart' },
      { value: 1, label: '2. purchase' },
    ]);
  });
});

describe('toggleStepSelection', () => {
  it('appends absent goals in click order and removes present ones', () => {
    let sel: string[] = [];
    sel = toggleStepSelection(sel, 'a');
    sel = toggleStepSelection(sel, 'b');
    expect(sel).toEqual(['a', 'b']);
    sel = toggleStepSelection(sel, 'a');
    expect(sel).toEqual(['b']);
  });
});

describe('deriveFunnelId', () => {
  it('slugifies names into stable lowercase ids', () => {
    expect(deriveFunnelId('Checkout Flow!')).toBe('checkout-flow');
    expect(deriveFunnelId('   ')).toBe('funnel');
  });
});

describe('buildDraftPayload', () => {
  it('requires a name and at least 2 steps', () => {
    expect(buildDraftPayload('', ['a', 'b'])).toEqual({ ok: false, error: 'Give the funnel a name.' });
    expect(buildDraftPayload('Checkout', ['a'])).toEqual({ ok: false, error: 'Pick at least 2 goals — a funnel is a sequence.' });
  });
  it('builds the ordered draft body with a derived id', () => {
    const r = buildDraftPayload('Checkout', ['add_to_cart', 'purchase']);
    expect(r).toEqual({
      ok: true,
      funnelId: 'checkout',
      body: { displayName: 'Checkout', steps: [{ goalId: 'add_to_cart' }, { goalId: 'purchase' }] },
    });
  });
  it('caps at 12 steps', () => {
    const many = Array.from({ length: 13 }, (_, i) => `g${i}`);
    expect(buildDraftPayload('Big', many).ok).toBe(false);
  });
});
