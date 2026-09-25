import { afterEach, describe, expect, it } from 'vitest';
import { takeHashParam } from './hash-param';

// E2: the dashboard appends its credential to the site's own fragment instead
// of replacing it; this must take it back out and leave the site's hash —
// including a hash route — exactly as it was.
const at = (url: string) => window.history.replaceState(null, '', url);

describe('takeHashParam', () => {
  afterEach(() => at('/'));

  it.each([
    ['/#k=v', '', '/'],
    ['/p?q=1#k=v', '', '/p?q=1'],
    ['/#/pricing?k=v', '#/pricing', '/'],
    ['/#/p?x=1&k=v', '#/p?x=1', '/'],
    ['/#/p?k=v&x=1', '#/p?x=1', '/'],
    ['/#k=v&x=1', '#x=1', '/'],
    ['/#a=1&k=v&b=2', '#a=1&b=2', '/'],
    ['/#section?k=v', '#section', '/'],
  ])('%s → value taken, hash %j restored', (url, hash, path) => {
    at(url);
    expect(takeHashParam('k')).toBe('v');
    expect(window.location.hash).toBe(hash);
    expect(window.location.pathname + window.location.search).toBe(path);
    expect(window.location.href.endsWith('#')).toBe(false);
  });

  it('keeps the query untouched and returns null when absent', () => {
    at('/p?q=1#/route');
    expect(takeHashParam('k')).toBeNull();
    expect(window.location.hash).toBe('#/route');
    expect(window.location.search).toBe('?q=1');
  });

  it('does not match a param that merely ends with the name', () => {
    at('/#xk=v');
    expect(takeHashParam('k')).toBeNull();
    expect(window.location.hash).toBe('#xk=v');
  });

  it('keeps history.state (a hash router stores its entry key there)', () => {
    window.history.replaceState({ key: 'abc', idx: 3 }, '', '/#/r?k=v');
    takeHashParam('k');
    expect(window.history.state).toEqual({ key: 'abc', idx: 3 });
  });
});
