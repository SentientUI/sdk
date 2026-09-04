import type { GoalDefinition } from '@sentientui/core';
import { pathname, resolveLocatorOne } from './locator';

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

/**
 * sessionStorage key holding the goals already fired this session.
 *
 * Namespaced by apiKey like every other browser key we own
 * (`_snt_retry_${apiKey.slice(0,12)}` and friends). This was the ONE key that
 * wasn't, so two SentientUI projects on the same origin shared it and each
 * one's `signup` goal suppressed the other's for the whole tab session.
 */
export function firedGoalsKey(apiKey?: string): string {
  return apiKey ? `_snt_fired_goals_${apiKey.slice(0, 12)}` : '_snt_fired_goals';
}

/** @deprecated Use firedGoalsKey(apiKey) — kept for the teardown path. */
export const FIRED_GOALS_KEY = '_snt_fired_goals';

/** Remove the fired-goal latches for this project (and the legacy shared key).
 *  Called from the snippet's revoke/forget-me path: without it the
 *  `_snt_fired_goals_*` sessionStorage entry kept naming the visitor's
 *  conversions after consent was revoked — forget-me wasn't total
 *  (audit SNIP-12, privacy). */
export function clearFiredGoals(win: Window | null, apiKey?: string): void {
  try {
    win?.sessionStorage.removeItem(firedGoalsKey(apiKey));
    win?.sessionStorage.removeItem(FIRED_GOALS_KEY);
  } catch {
    /* storage unavailable — nothing persisted to clear */
  }
}

/**
 * Dedupe identity for one wired goal.
 *
 * The goal id ALONE collided: the same id on two slots recorded once, and two
 * definitions sharing an id but differing in trigger or element shadowed each
 * other. Include everything that makes the wiring distinct.
 */
function firedKeyFor(g: GoalDefinition): string {
  return [g.slotId ?? '', g.goalId, g.event, g.locator ? JSON.stringify(g.locator) : ''].join('|');
}

function readFired(win: Window | null, storageKey: string): Set<string> {
  try {
    const raw = win?.sessionStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function persistFired(win: Window | null, storageKey: string, fired: Set<string>): void {
  try {
    win?.sessionStorage.setItem(storageKey, JSON.stringify([...fired]));
  } catch {
    /* storage unavailable (private mode, blocked) — degrade to per-page dedupe */
  }
}

export function installGoalListeners(
  goals: GoalDefinition[],
  client: GoalClient,
  doc: Document,
  apiKey?: string,
): GoalListeners {
  const win = doc.defaultView ?? (typeof window !== 'undefined' ? window : null);
  const storageKey = firedGoalsKey(apiKey);
  const fired = readFired(win, storageKey);
  const fire = (g: GoalDefinition): void => {
    const key = firedKeyFor(g);
    if (fired.has(key)) return;
    try {
      if (g.slotId) client.componentGoal(g.slotId, g.goalId);
      else client.goal(g.goalId);
      // Latch AFTER the call, not before. client.goal can no-op (not yet
      // initialized, consent withheld), and marking first meant a goal that
      // never left the page was suppressed for the rest of the session.
      fired.add(key);
      persistFired(win, storageKey, fired);
    } catch {
      /* fail-safe — an unrecorded goal may retry on the next interaction */
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
    // Nothing left to watch for once they've all fired. Checked via
    // firedKeyFor: `fired` holds COMPOSITE keys, so testing the bare goalId
    // here was always false and the scroll handler ran on every scroll for
    // the rest of the page's life.
    if (scrollGoals.every((g) => fired.has(firedKeyFor(g)))) {
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
