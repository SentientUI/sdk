import { describe, expect, it } from 'vitest';
import { classifyArrival, normalizeLandingPath, type ArrivalInput } from './arrival';

const IG_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 324.0.0.27.50';
const FB_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/455.0.0.36.103]';
const TT_UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 musical_ly_2023405030 BytedanceWebview/d8a21c6';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

const cases: Array<[string, ArrivalInput, { channel: string; platform: string | null; paid: boolean; attributed?: boolean }]> = [
  // Google
  ['Google search ad, auto-tagged', { clickIdKeys: ['gclid'], referrerHost: 'www.google.com' }, { channel: 'paid_search', platform: 'google', paid: true }],
  ['Google ad on iOS (gbraid)', { clickIdKeys: ['gbraid'] }, { channel: 'paid_search', platform: 'google', paid: true }],
  ['YouTube ad (gclid from youtube)', { clickIdKeys: ['gclid'], referrerHost: 'm.youtube.com' }, { channel: 'video', platform: 'youtube', paid: true }],
  ['Google organic', { referrerHost: 'www.google.co.uk' }, { channel: 'organic_search', platform: 'google', paid: false }],
  ['Google Shopping via utm', { utmParams: { utm_source: 'google', utm_medium: 'shopping' } }, { channel: 'paid_search', platform: 'google', paid: true }],
  ['Gemini answer', { referrerHost: 'gemini.google.com' }, { channel: 'ai_assistant', platform: 'gemini', paid: false }],
  ['Gmail link', { referrerHost: 'mail.google.com' }, { channel: 'email_sms', platform: 'gmail', paid: false }],
  // Meta
  ['Meta paid social with utm', { utmParams: { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'spring_sale' }, clickIdKeys: ['fbclid'] }, { channel: 'paid_social', platform: 'meta', paid: true }],
  ['fbclid alone is organic Meta', { clickIdKeys: ['fbclid'] }, { channel: 'organic_social', platform: 'meta', paid: false }],
  ['Instagram referrer', { referrerHost: 'l.instagram.com' }, { channel: 'organic_social', platform: 'meta', paid: false }],
  ['Instagram in-app, no referrer', { userAgent: IG_UA }, { channel: 'organic_social', platform: 'meta', paid: false }],
  ['Facebook in-app, no referrer', { userAgent: FB_UA }, { channel: 'organic_social', platform: 'meta', paid: false }],
  // TikTok, Pinterest, others
  ['TikTok ad', { clickIdKeys: ['ttclid'] }, { channel: 'paid_social', platform: 'tiktok', paid: true }],
  ['TikTok in-app, no referrer', { userAgent: TT_UA }, { channel: 'organic_social', platform: 'tiktok', paid: false }],
  ['TikTok referrer', { referrerHost: 'www.tiktok.com' }, { channel: 'organic_social', platform: 'tiktok', paid: false }],
  ['Pinterest', { referrerHost: 'www.pinterest.co.uk' }, { channel: 'organic_social', platform: 'pinterest', paid: false }],
  ['YouTube video description link', { referrerHost: 'www.youtube.com' }, { channel: 'video', platform: 'youtube', paid: false }],
  ['Microsoft Ads', { clickIdKeys: ['msclkid'] }, { channel: 'paid_search', platform: 'microsoft', paid: true }],
  ['LinkedIn ad', { clickIdKeys: ['li_fat_id'] }, { channel: 'paid_social', platform: 'linkedin', paid: true }],
  // Email / SMS
  ['Klaviyo abandoned cart', { utmParams: { utm_source: 'klaviyo', utm_medium: 'email', utm_campaign: 'abandoned_cart' } }, { channel: 'email_sms', platform: 'klaviyo', paid: false }],
  ['Shopify Email', { utmParams: { utm_source: 'shopify_email', utm_medium: 'email' } }, { channel: 'email_sms', platform: 'shopify_email', paid: false }],
  ['Attentive SMS', { utmParams: { utm_source: 'attentive', utm_medium: 'sms' } }, { channel: 'email_sms', platform: 'attentive', paid: false }],
  // Affiliates, AI, apps
  ['Affiliate', { utmParams: { utm_source: 'some-blog', utm_medium: 'affiliate' } }, { channel: 'affiliate', platform: 'some-blog', paid: false }],
  ['ChatGPT referral', { referrerHost: 'chatgpt.com' }, { channel: 'ai_assistant', platform: 'chatgpt', paid: false }],
  ['ChatGPT utm_source (ChatGPT tags its links)', { utmParams: { utm_source: 'chatgpt.com' } }, { channel: 'ai_assistant', platform: 'chatgpt', paid: false }],
  ['Perplexity', { referrerHost: 'www.perplexity.ai' }, { channel: 'ai_assistant', platform: 'perplexity', paid: false }],
  ['Shop app', { referrerHost: 'shop.app' }, { channel: 'marketplace_app', platform: 'shop_app', paid: false }],
  // Fallbacks
  ['A blog link', { referrerHost: 'www.someblog.com' }, { channel: 'referral', platform: 'someblog.com', paid: false }],
  ['A display network', { utmParams: { utm_source: 'criteo', utm_medium: 'display' } }, { channel: 'referral', platform: 'criteo', paid: true }],
  ['Direct', { userAgent: SAFARI }, { channel: 'direct', platform: null, paid: false, attributed: false }],
  ['Internal navigation is not a referral', { referrerHost: 'www.store.com', siteHost: 'store.com' }, { channel: 'direct', platform: null, paid: false, attributed: false }],
  ['Subdomain of the site is internal', { referrerHost: 'shop.store.com', siteHost: 'www.store.com' }, { channel: 'direct', platform: null, paid: false, attributed: false }],
];

describe('classifyArrival', () => {
  it.each(cases)('%s', (_name, input, expected) => {
    const got = classifyArrival(input);
    expect({ channel: got.channel, platform: got.platform, paid: got.paid }).toEqual({
      channel: expected.channel, platform: expected.platform, paid: expected.paid,
    });
    expect(got.attributed).toBe(expected.attributed ?? true);
  });

  it('UTMs win over the referrer and the click ID', () => {
    const got = classifyArrival({
      utmParams: { utm_source: 'klaviyo', utm_medium: 'email' },
      clickIdKeys: ['fbclid'],
      referrerHost: 'l.facebook.com',
    });
    expect(got.channel).toBe('email_sms');
  });

  it('is case-insensitive on UTMs', () => {
    expect(classifyArrival({ utmParams: { UTM_SOURCE: 'Facebook', utm_medium: 'CPC' } }).channel).toBe('paid_social');
  });
});

describe('normalizeLandingPath', () => {
  it('keeps only the path — never the query string, which can carry tokens', () => {
    expect(normalizeLandingPath('https://store.com/products/shoe?variant=1&key=secret#x')).toBe('/products/shoe');
    expect(normalizeLandingPath('/discount/SPRING20?redirect=/collections/all')).toBe('/discount/SPRING20');
  });
  it('rejects junk', () => {
    expect(normalizeLandingPath('javascript:alert(1)')).toBeNull();
    expect(normalizeLandingPath('')).toBeNull();
    expect(normalizeLandingPath(null)).toBeNull();
  });
  it('caps length', () => {
    expect(normalizeLandingPath('/' + 'a'.repeat(500))!.length).toBe(256);
  });
});
