/**
 * Where a registry component is EXPECTED to exist — `CompoundLocator.page`.
 *
 *   '*'            every page
 *   '/pricing'     exactly that path (a trailing slash is ignored)
 *   '/products/*'  any path under /products/ (not /products itself)
 *
 * It answers one question only: "if this component's element is absent here,
 * is that a broken locator?" It does NOT gate serving — a component is decided
 * wherever its element resolves. Before it existed nothing recorded where a
 * component belongs, so an absence on any page was reported as a locator miss:
 * on a multi-page site a component that lives only on /pricing collected misses
 * from every other page view and was auto-suspended as "element not found"
 * while working fine. Unscoped (legacy) components therefore report only
 * verification failures, never absence.
 */
export const PAGE_SCOPE_RE = /^(\*|\/[^\s?#*]*(\/\*)?)$/;

function normalizePath(path: string): string {
  const p = path.split(/[?#]/)[0] || '/';
  return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
}

export function pageScopeMatches(page: string | undefined, pathname: string): boolean {
  if (page === undefined || !PAGE_SCOPE_RE.test(page)) return false;
  if (page === '*') return true;
  const path = normalizePath(pathname);
  if (page.endsWith('/*')) {
    const prefix = normalizePath(page.slice(0, -2));
    return path.startsWith(prefix === '/' ? '/' : `${prefix}/`) && path !== prefix;
  }
  return path === normalizePath(page);
}
