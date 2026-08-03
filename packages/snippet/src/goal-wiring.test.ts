import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installGoalListeners, urlMatches } from './goal-wiring';
import type { GoalDefinition } from '@sentientui/core';

function mockClient() {
  return { goal: vi.fn(), componentGoal: vi.fn() };
}
function click(el: Element) {
  el.dispatchEvent(new Event('click', { bubbles: true }));
}

beforeEach(() => { document.body.innerHTML = ''; });
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
