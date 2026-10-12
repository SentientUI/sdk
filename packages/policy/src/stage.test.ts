import { describe, expect, it } from 'vitest';
import {
  arrivalClass,
  campaignIntentOf,
  computeStage,
  resolveContext,
  stageHintFor,
  type ArrivalFacts,
  type StageHistory,
} from './stage';

const W = { cartWindowDays: 14, lapseWindowDays: 90 };
const NOW = new Date('2026-10-09T12:00:00Z');
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 86_400_000);
const h = (over: Partial<StageHistory> = {}): StageHistory =>
  ({ returning: false, purchaseCount: 0, lastPurchaseAt: null, lastCartAt: null, ...over });

describe('computeStage', () => {
  it.each<[string, StageHistory, string]>([
    ['first visit, no history', h(), 'new'],
    ['returning, no cart, never bought', h({ returning: true }), 'browsing'],
    ['cart 3 days ago', h({ returning: true, lastCartAt: daysAgo(3) }), 'carted'],
    ['cart outside the window', h({ returning: true, lastCartAt: daysAgo(20) }), 'browsing'],
    ['bought 10 days ago', h({ returning: true, purchaseCount: 1, lastPurchaseAt: daysAgo(10) }), 'customer'],
    ['bought 200 days ago', h({ returning: true, purchaseCount: 2, lastPurchaseAt: daysAgo(200) }), 'lapsed'],
    ['carted after buying — the live cart wins', h({ returning: true, purchaseCount: 1, lastPurchaseAt: daysAgo(30), lastCartAt: daysAgo(2) }), 'carted'],
    ['cart BEFORE the purchase is not a live cart', h({ returning: true, purchaseCount: 1, lastPurchaseAt: daysAgo(2), lastCartAt: daysAgo(3) }), 'customer'],
    ['a cart on the first visit', h({ lastCartAt: daysAgo(0) }), 'carted'],
  ])('%s → %s', (_n, history, stage) => {
    expect(computeStage(history, W, NOW)).toEqual({ stage, source: 'observed' });
  });

  it('a purchase moves carted → customer', () => {
    const before = h({ returning: true, lastCartAt: daysAgo(1) });
    const after = { ...before, purchaseCount: 1, lastPurchaseAt: daysAgo(0) };
    expect(computeStage(before, W, NOW).stage).toBe('carted');
    expect(computeStage(after, W, NOW).stage).toBe('customer');
  });

  it('a refund does not move a customer back (the history is unchanged)', () => {
    const bought = h({ returning: true, purchaseCount: 1, lastPurchaseAt: daysAgo(5) });
    expect(computeStage(bought, W, NOW).stage).toBe('customer');
  });

  describe('hints', () => {
    it('raise a visitor with no buying history, marked hinted', () => {
      expect(computeStage(h(), W, NOW, 'carted')).toEqual({ stage: 'carted', source: 'hinted' });
      expect(computeStage(h({ returning: true }), W, NOW, 'lapsed')).toEqual({ stage: 'lapsed', source: 'hinted' });
      expect(computeStage(h(), W, NOW, 'browsing')).toEqual({ stage: 'browsing', source: 'hinted' });
    });
    it('never override history', () => {
      const customer = h({ returning: true, purchaseCount: 1, lastPurchaseAt: daysAgo(5) });
      expect(computeStage(customer, W, NOW, 'carted')).toEqual({ stage: 'customer', source: 'observed' });
    });
    it('a browsing hint on a browsing visitor is just observed', () => {
      expect(computeStage(h({ returning: true }), W, NOW, 'browsing')).toEqual({ stage: 'browsing', source: 'observed' });
    });
  });
});

describe('arrivalClass', () => {
  const a = (over: Partial<ArrivalFacts>): ArrivalFacts =>
    ({ channel: null, paid: false, landingPath: null, campaignIntent: null, hasSearchTerm: false, ...over });

  it.each<[string, ArrivalFacts, string | null]>([
    ['cart-recovery email', a({ channel: 'email_sms', campaignIntent: 'cart_recovery', landingPath: '/products/shoe' }), 'cart_recovery'],
    ['Shopify discount link', a({ channel: 'email_sms', landingPath: '/discount/SPRING20' }), 'offer'],
    ['mapped sale campaign', a({ channel: 'paid_social', paid: true, campaignIntent: 'offer' }), 'offer'],
    ['Shopping ad to a product page', a({ channel: 'paid_search', paid: true, landingPath: '/products/shoe' }), 'product_ad'],
    ['Meta catalog ad to a nested product page', a({ channel: 'paid_social', paid: true, landingPath: '/collections/running/products/shoe' }), 'product_ad'],
    ['paid search with a keyword', a({ channel: 'paid_search', paid: true, landingPath: '/collections/running', hasSearchTerm: true }), 'search_intent'],
    ['retargeting campaign', a({ channel: 'paid_social', paid: true, campaignIntent: 'retargeting', landingPath: '/' }), 'retargeting'],
    ['YouTube review', a({ channel: 'video' }), 'referred'],
    ['ChatGPT answer', a({ channel: 'ai_assistant' }), 'referred'],
    ['paid social to the home page', a({ channel: 'paid_social', paid: true, landingPath: '/' }), 'paid_prospecting'],
    ['organic search', a({ channel: 'organic_search' }), null],
    ['direct', a({ channel: 'direct' }), null],
    ['an organic product link is not a product ad', a({ channel: 'organic_social', landingPath: '/products/shoe' }), null],
  ])('%s → %s', (_n, facts, cls) => {
    expect(arrivalClass(facts)).toBe(cls);
  });
});

describe('resolveContext / campaign helpers', () => {
  it('an arrival class wins over the stage for the visit', () => {
    expect(resolveContext('customer', 'offer')).toBe('offer');
    expect(resolveContext('customer', null)).toBe('customer');
  });
  it('maps confirmed campaign tags, case-insensitively, and ignores unknown tags', () => {
    const map = { abandoned_cart: 'cart_recovery', spring_sale: 'offer', weird: 'nonsense' };
    expect(campaignIntentOf(map, 'Abandoned_Cart')).toBe('cart_recovery');
    expect(campaignIntentOf(map, 'weird')).toBeNull();
    expect(campaignIntentOf(map, null)).toBeNull();
    expect(stageHintFor('cart_recovery')).toBe('carted');
    expect(stageHintFor('win_back')).toBe('lapsed');
    expect(stageHintFor('offer')).toBeNull();
  });
});
