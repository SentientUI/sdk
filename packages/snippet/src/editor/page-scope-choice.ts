import { PAGE_SCOPE_RE } from '@sentientui/core';

// "Where does this appear?" for components saved from the editor. The locator's
// `page` (core page-scope.ts) is what tells a MOVED element apart from a page the
// component simply isn't on: editor locators used to carry no scope, so a
// component living only on /pricing collected "element not found" misses from
// every other page view and was auto-suspended while working fine.

/** location.pathname → the scope form: query/hash stripped, trailing slash
 *  dropped except on the root. */
export function normalizePagePath(pathname: string): string {
  const p = pathname.split(/[?#]/)[0] || '/';
  return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
}

/** Plain-language name for a scope value; `here` is the operator's current
 *  (normalized) path, so a kept scope for another page doesn't read as "This page". */
export function pageScopeLabel(page: string, here: string): string {
  if (page === '*') return 'Every page';
  if (page.endsWith('/*')) return `All pages under ${page.slice(0, -1)}`;
  return page === here ? `This page (${page})` : `Only on ${page}`;
}

/**
 * The offered scopes for the current path, "This page" first (the default).
 * The prefix option needs ≥2 segments: on /pricing, "everything under /pricing/"
 * would EXCLUDE the page the operator is standing on. A path the server's
 * PAGE_SCOPE_RE would reject (a literal `*` in the URL) offers only "Every
 * page" rather than a choice that fails on save.
 */
export function pageScopeChoices(pathname: string, existing?: string): string[] {
  const path = normalizePagePath(pathname);
  const segs = path.split('/').filter(Boolean);
  const out = [path, '*'];
  if (segs.length >= 2) out.push(`/${segs[0]}/*`);
  // An existing scope set elsewhere (e.g. '/blog/*' from the dashboard) stays
  // selectable — re-saving from another page must not silently drop it.
  // First, so it is also the default the <select> lands on.
  return (existing ? [existing, ...out.filter((v) => v !== existing)] : out).filter((v) => PAGE_SCOPE_RE.test(v));
}
