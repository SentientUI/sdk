import type { GoalDefinition } from '@sentientui/core';
import { resolveLocatorOne } from './locator';

// Editor-defined goal wiring (Phase 3, §2.2). One delegated click listener and
// one submit listener at the document root; url_reached checked on load + on
// navigation. Each goal fires at most once per session (matching existing goal
// semantics), through the client's goal()/componentGoal() paths so close-out
// crediting is untouched. Never installed for a consent-gated client (caller's
// responsibility — see run()).

type GoalClient = {
  goal(name: string, metadata?: Record<string, unknown>): void;
  componentGoal(slotId: string, goalType: string): void;
};

export type GoalListeners = { teardown: () => void; checkUrl: () => void };

function pathname(doc: Document): string {
  const loc = (doc.defaultView ?? (typeof window !== 'undefined' ? window : undefined))?.location;
  return loc?.pathname ?? '';
}

// A url_reached pattern matches the current path on an exact hit or a path-segment
// boundary — never a bare substring. Substring matching made the degenerate '/'
// pattern (what the editor's "Track page visits" button saves on a homepage)
// contain every path, firing the homepage goal on every route; it also let
// '/pricing' over-match '/pricing-details'. The root '/' now matches only '/',
// and '/pricing' matches '/pricing' and '/pricing/monthly' but not '/pricing-x'.
export function urlMatches(pattern: string, path: string): boolean {
  if (!pattern) return false;
  if (pattern === '/') return path === '/';
  const p = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  return path === p || path.startsWith(`${p}/`);
}

export function installGoalListeners(goals: GoalDefinition[], client: GoalClient, doc: Document): GoalListeners {
  const fired = new Set<string>();
  const fire = (g: GoalDefinition): void => {
    if (fired.has(g.goalId)) return;
    fired.add(g.goalId);
    try {
      if (g.slotId) client.componentGoal(g.slotId, g.goalId);
      else client.goal(g.goalId);
    } catch {
      /* fail-safe */
    }
  };

  const clickGoals = goals.filter((g) => g.event === 'click');
  const submitGoals = goals.filter((g) => g.event === 'form_submit');
  const urlGoals = goals.filter((g) => g.event === 'url_reached');

  // A goal matches if the event target is the located element or inside it.
  const matches = (g: GoalDefinition, target: Element): boolean => {
    if (!g.locator) return false;
    const el = resolveLocatorOne(g.locator, doc);
    return !!el && (el === target || el.contains(target));
  };

  const onClick = (e: Event): void => {
    const target = e.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;
    for (const g of clickGoals) if (matches(g, target)) fire(g);
  };
  const onSubmit = (e: Event): void => {
    const target = e.target as Element | null;
    if (!target) return;
    for (const g of submitGoals) if (matches(g, target)) fire(g);
  };
  const checkUrl = (): void => {
    if (urlGoals.length === 0) return;
    const path = pathname(doc);
    for (const g of urlGoals) if (g.urlPattern && urlMatches(g.urlPattern, path)) fire(g);
  };

  doc.addEventListener('click', onClick, true);
  doc.addEventListener('submit', onSubmit, true);
  doc.defaultView?.addEventListener('popstate', checkUrl);
  checkUrl(); // on load

  return {
    checkUrl,
    teardown: () => {
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('submit', onSubmit, true);
      doc.defaultView?.removeEventListener('popstate', checkUrl);
    },
  };
}
