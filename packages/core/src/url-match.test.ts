import { describe, expect, it } from 'vitest';
import { normalizeUrlPattern, urlMatches } from './url-match';

describe('urlMatches', () => {
  it('matches exact paths and path-segment prefixes, never bare substrings', () => {
    expect(urlMatches('/pricing', '/pricing')).toBe(true);
    expect(urlMatches('/pricing', '/pricing/monthly')).toBe(true);
    expect(urlMatches('/pricing/', '/pricing')).toBe(true);
    expect(urlMatches('/pricing', '/pricing-details')).toBe(false);
    expect(urlMatches('/', '/')).toBe(true);
    expect(urlMatches('/', '/docs')).toBe(false);
    expect(urlMatches('', '/')).toBe(false);
  });
});

describe('normalizeUrlPattern', () => {
  it('reduces a full URL to its path', () => {
    expect(normalizeUrlPattern('https://www.sentient-ui.com/pricing')).toBe('/pricing');
    expect(normalizeUrlPattern('https://www.sentient-ui.com')).toBe('/');
  });
  it('passes a path through unchanged', () => {
    expect(normalizeUrlPattern('/docs')).toBe('/docs');
  });
});
