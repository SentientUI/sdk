import { describe, it, expect } from 'vitest';
import { pageScopeMatches } from './page-scope.js';

describe('pageScopeMatches', () => {
  it('matches exact paths ignoring a trailing slash, query and hash', () => {
    expect(pageScopeMatches('/pricing', '/pricing')).toBe(true);
    expect(pageScopeMatches('/pricing', '/pricing/')).toBe(true);
    expect(pageScopeMatches('/pricing/', '/pricing?x=1#y')).toBe(true);
    expect(pageScopeMatches('/pricing', '/pricing/annual')).toBe(false);
    expect(pageScopeMatches('/', '/pricing')).toBe(false); // the home page is not "every page"
  });

  it('matches prefixes below a /* scope, not the prefix itself', () => {
    expect(pageScopeMatches('/products/*', '/products/42')).toBe(true);
    expect(pageScopeMatches('/products/*', '/products/42/reviews')).toBe(true);
    expect(pageScopeMatches('/products/*', '/products')).toBe(false);
    expect(pageScopeMatches('/products/*', '/productsale')).toBe(false);
  });

  it('* is every page; undefined or malformed never matches', () => {
    expect(pageScopeMatches('*', '/anything')).toBe(true);
    expect(pageScopeMatches(undefined, '/pricing')).toBe(false);
    expect(pageScopeMatches('pricing', '/pricing')).toBe(false);
    expect(pageScopeMatches('/a/*/b', '/a/x/b')).toBe(false);
  });
});
