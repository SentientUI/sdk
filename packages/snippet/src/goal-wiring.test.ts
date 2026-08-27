import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FIRED_GOALS_KEY, installGoalListeners, urlMatches } from './goal-wiring';
import type { GoalDefinition } from '@sentientui/core';

function mockClient() {
  return { goal: vi.fn(), componentGoal: vi.fn() };
}
function click(el: Element) {
  el.dispatchEvent(new Event('click', { bubbles: true }));
}

// Goals now dedupe through sessionStorage (once per SESSION, not per page
// load), so a fired goal would otherwise leak into the next test.
beforeEach(() => { document.body.innerHTML = ''; sessionStorage.clear(); });
// Some tests navigate to non-root paths; restore "/" so path-sensitive tests below
// (and the suite's default assumptions) stay isolated.
afterEach(() => { window.history.pushState({}, '', '/'); });

describe('urlMatches', () => {
  it('root "/" matches only the root path', () => {
    expect(urlMatches('/', '/')).toBe(true);
    expect(urlMatches('/', '/pricing')).toBe(false);
    expect(urlMatches('/', '/anything/deep')).toBe(false);
  });
  it('non-root patterns match exactly or on a segment boundary, never a bare substring', () => {
    expect(urlMatches('/pricing', '/pricing')).toBe(true);
    expect(urlMatches('/pricing', '/pricing/monthly')).toBe(true);
    expect(urlMatches('/pricing', '/pricing-details')).toBe(false);
    expect(urlMatches('/pricing/', '/pricing/monthly')).toBe(true); // trailing slash normalized
  });
  it('empty pattern never matches', () => {
    expect(urlMatches('', '/')).toBe(false);
  });
});

describe('installGoalListeners', () => {
  it('fires a click goal via delegation (target inside the located element)', () => {
    document.body.innerHTML = '<a id="cta"><span>Book</span></a>';
    const client = mockClient();
    const goals: GoalDefinition[] = [{ goalId: 'demo', event: 'click', locator: { id: 'cta' } }];
    const l = installGoalListeners(goals, client, document);
    click(document.querySelector('#cta span')!);
    expect(client.goal).toHaveBeenCalledWith('demo');
    l.teardown();
  });

  it('uses componentGoal when slotId is set', () => {
    document.body.innerHTML = '<a id="cta">x</a>';
    const client = mockClient();
    installGoalListeners([{ goalId: 'demo', event: 'click', locator: { id: 'cta' }, slotId: 'hero' }], client, document);
    click(document.getElementById('cta')!);
    expect(client.componentGoal).toHaveBeenCalledWith('hero', 'demo');
    expect(client.goal).not.toHaveBeenCalled();
  });

  it('fires at most once per session', () => {
    document.body.innerHTML = '<a id="cta">x</a>';
    const client = mockClient();
    installGoalListeners([{ goalId: 'demo', event: 'click', locator: { id: 'cta' } }], client, document);
    const el = document.getElementById('cta')!;
    click(el);
    click(el);
    expect(client.goal).toHaveBeenCalledTimes(1);
  });

  it('fires a form_submit goal', () => {
    document.body.innerHTML = '<form id="signup"><button>Go</button></form>';
    const client = mockClient();
    installGoalListeners([{ goalId: 'signup', event: 'form_submit', locator: { id: 'signup' } }], client, document);
    document.getElementById('signup')!.dispatchEvent(new Event('submit', { bubbles: true }));
    expect(client.goal).toHaveBeenCalledWith('signup');
  });

  it('fires a url_reached goal on load when the path matches', () => {
    const client = mockClient();
    installGoalListeners([{ goalId: 'home', event: 'url_reached', urlPattern: '/' }], client, document);
    expect(client.goal).toHaveBeenCalledWith('home');
  });

  it('does not fire url_reached when the path does not match', () => {
    const client = mockClient();
    installGoalListeners([{ goalId: 'ty', event: 'url_reached', urlPattern: '/thank-you' }], client, document);
    expect(client.goal).not.toHaveBeenCalled();
  });

  it('does NOT fire a homepage "/" goal on a non-root path (no substring over-match)', () => {
    // The editor's "Track page visits" button saves urlPattern = window.location
    // .pathname, which is "/" on a homepage. Substring matching (path.includes)
    // made "/" contained by every path, firing the homepage goal on every route
    // — the goal count then equalled total sessions (audit).
    window.history.pushState({}, '', '/pricing');
    const client = mockClient();
    installGoalListeners([{ goalId: 'home', event: 'url_reached', urlPattern: '/' }], client, document);
    expect(client.goal).not.toHaveBeenCalled();
  });

  it('matches a non-root pattern on a path-segment boundary, not a bare substring', () => {
    window.history.pushState({}, '', '/pricing-details');
    const c1 = mockClient();
    installGoalListeners([{ goalId: 'p', event: 'url_reached', urlPattern: '/pricing' }], c1, document);
    expect(c1.goal).not.toHaveBeenCalled(); // "/pricing" must NOT match "/pricing-details"

    window.history.pushState({}, '', '/pricing/monthly');
    const c2 = mockClient();
    installGoalListeners([{ goalId: 'p', event: 'url_reached', urlPattern: '/pricing' }], c2, document);
    expect(c2.goal).toHaveBeenCalledWith('p'); // but DOES match a nested route
  });

  it('teardown removes the listeners', () => {
    document.body.innerHTML = '<a id="cta">x</a>';
    const client = mockClient();
    const l = installGoalListeners([{ goalId: 'demo', event: 'click', locator: { id: 'cta' } }], client, document);
    l.teardown();
    click(document.getElementById('cta')!);
    expect(client.goal).not.toHaveBeenCalled();
  });
});

describe('scroll_depth goals', () => {
  function setScroll(doc: Document, scrollTop: number, clientHeight: number, scrollHeight: number) {
    Object.defineProperty(doc.documentElement, 'scrollTop', { value: scrollTop, configurable: true });
    Object.defineProperty(doc.documentElement, 'clientHeight', { value: clientHeight, configurable: true });
    Object.defineProperty(doc.documentElement, 'scrollHeight', { value: scrollHeight, configurable: true });
  }

  it('fires once when the page is scrolled past the threshold', () => {
    const client = mockClient();
    const goal: GoalDefinition = { goalId: 'read-75', event: 'scroll_depth', threshold: 0.75 };
    setScroll(document, 0, 500, 2000); // 25% - below
    const listeners = installGoalListeners([goal], client, document);
    expect(client.goal).not.toHaveBeenCalled();
    setScroll(document, 1200, 500, 2000); // 85% - past
    document.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new Event('scroll'));
    expect(client.goal).toHaveBeenCalledTimes(1); // once per session
    expect(client.goal).toHaveBeenCalledWith('read-75');
    listeners.teardown();
  });

  it('checks depth at install time for short pages already past the threshold', () => {
    const client = mockClient();
    setScroll(document, 0, 800, 800); // page fits the viewport -> depth 1
    installGoalListeners([{ goalId: 'read-50', event: 'scroll_depth', threshold: 0.5 }], client, document);
    expect(client.goal).toHaveBeenCalledWith('read-50');
  });

  it('teardown removes the scroll listener', () => {
    const client = mockClient();
    setScroll(document, 0, 500, 2000);
    const listeners = installGoalListeners(
      [{ goalId: 'read-75', event: 'scroll_depth', threshold: 0.75 }], client, document);
    listeners.teardown();
    setScroll(document, 1500, 500, 2000);
    document.dispatchEvent(new Event('scroll'));
    expect(client.goal).not.toHaveBeenCalled();
  });
});

// SNIP-01: the snippet targets multi-page sites, where every navigation
// reloads the page and re-installs these listeners. Dedupe held in a closure
// resets with it, so a page-visit goal re-fired on every visit and inflated the
// Hits column without limit.
describe('once-per-session dedupe survives a page load', () => {
  const pageGoal: GoalDefinition[] = [{ goalId: 'saw_pricing', event: 'url_reached', urlPattern: '/pricing' }];

  it('fires a url_reached goal once across repeated installs', () => {
    window.history.pushState({}, '', '/pricing');
    const client = mockClient();

    const first = installGoalListeners(pageGoal, client, document);
    expect(client.goal).toHaveBeenCalledTimes(1);
    first.teardown();

    // Same session, visitor navigates back to /pricing: fresh listeners, no refire.
    const second = installGoalListeners(pageGoal, client, document);
    expect(client.goal).toHaveBeenCalledTimes(1);
    second.teardown();
  });

  it('records the fired id in sessionStorage', () => {
    window.history.pushState({}, '', '/pricing');
    installGoalListeners(pageGoal, mockClient(), document).teardown();
    expect(JSON.parse(sessionStorage.getItem(FIRED_GOALS_KEY)!)).toContain('saw_pricing');
  });

  it('fires again in a new session', () => {
    window.history.pushState({}, '', '/pricing');
    const client = mockClient();
    installGoalListeners(pageGoal, client, document).teardown();
    sessionStorage.clear(); // a new session id / new browser session
    installGoalListeners(pageGoal, client, document).teardown();
    expect(client.goal).toHaveBeenCalledTimes(2);
  });

  it('still fires once when sessionStorage is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new Error('blocked'); },
    });
    try {
      window.history.pushState({}, '', '/pricing');
      const client = mockClient();
      const l = installGoalListeners(pageGoal, client, document);
      // Degrades to per-page dedupe rather than throwing or double-firing here.
      l.checkUrl();
      expect(client.goal).toHaveBeenCalledTimes(1);
      l.teardown();
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });

  it('ignores a corrupt bucket instead of throwing', () => {
    sessionStorage.setItem(FIRED_GOALS_KEY, 'not json');
    window.history.pushState({}, '', '/pricing');
    const client = mockClient();
    expect(() => installGoalListeners(pageGoal, client, document).teardown()).not.toThrow();
    expect(client.goal).toHaveBeenCalledTimes(1);
  });
});
