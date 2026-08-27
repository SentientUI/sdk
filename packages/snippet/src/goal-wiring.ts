import type { GoalDefinition } from '@sentientui/core';
import { resolveLocatorOne } from './locator';

// Editor-defined goal wiring (Phase 3, §2.2). One delegated click listener and
// one submit listener at the document root; url_reached checked on load + on
// navigation. Each goal fires at most once per SESSION, through the client's
// goal()/componentGoal() paths so close-out crediting is untouched. Never
// installed for a consent-gated client (caller's responsibility — see run()).
//
// "Once per session" needs sessionStorage, not a closure variable: the snippet
// targets multi-page sites (Webflow, WordPress, Shopify themes) where every
// navigation reloads the page and re-installs these listeners. An in-memory Set
// resets with it, so a url_reached goal on /pricing fired on every visit to
// /pricing. Nothing deduplicates it server-side either — /v1/goals dedupes only
// on the client event id. Training was insulated (close-out caps per-goal credit
// at min(1, Σ) and funnel reach counts DISTINCT session_id), but the Hits column
// is a COUNT(*) and inflated without limit.

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

/** sessionStorage key holding the goal ids already fired this session. */
export const FIRED_GOALS_KEY = '_snt_fired_goals';

function readFired(win: Window | null): Set<string> {
  try {
    const raw = win?.sessionStorage.getItem(FIRED_GOALS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function persistFired(win: Window | null, fired: Set<string>): void {
  try {
    win?.sessionStorage.setItem(FIRED_GOALS_KEY, JSON.stringify([...fired]));
  } catch {
    /* storage unavailable (private mode, blocked) — degrade to per-page dedupe */
  }
}

export function installGoalListeners(goals: GoalDefinition[], client: GoalClient, doc: Document): GoalListeners {
  const win = doc.defaultView ?? (typeof window !== 'undefined' ? window : null);
  const fired = readFired(win);
  const fire = (g: GoalDefinition): void => {
    if (fired.has(g.goalId)) return;
    fired.add(g.goalId);
    persistFired(win, fired);
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
  const scrollGoals = goals.filter((g) => g.event === 'scroll_depth');

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

  const onScrollDepth = (): void => {
    const d = doc.documentElement;
    const p = d.scrollHeight > 0 ? (d.scrollTop + d.clientHeight) / d.scrollHeight : 0;
    for (const g of scrollGoals) if (p >= (g.threshold ?? 0.75)) fire(g);
    // Nothing left to watch for once they've all fired.
    if (scrollGoals.every((g) => fired.has(g.goalId))) {
      doc.removeEventListener('scroll', onScrollDepth);
    }
  };

  doc.addEventListener('click', onClick, true);
  doc.addEventListener('submit', onSubmit, true);
  doc.defaultView?.addEventListener('popstate', checkUrl);
  checkUrl(); // on load
  if (scrollGoals.length > 0) {
    doc.addEventListener('scroll', onScrollDepth, { passive: true });
    onScrollDepth(); // short pages can already be past the threshold
  }

  return {
    checkUrl,
    teardown: () => {
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('submit', onSubmit, true);
      doc.defaultView?.removeEventListener('popstate', checkUrl);
      if (scrollGoals.length > 0) doc.removeEventListener('scroll', onScrollDepth);
    },
  };
}
