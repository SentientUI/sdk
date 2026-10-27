/**
 * Candidate domains for the shared visitor cookie. The visitor id lives on the
 * site's registrable domain (`example.com` for `app.example.com`), so a marketing
 * site and its app subdomain see ONE visitor: host-only cookies gave each host
 * its own id, and a journey that started on the landing page and converted in
 * the app (or the app's backend) could never be joined to the decisions that
 * earned it.
 *
 * Detection (session.ts `detectCookieDomain`) works the way analytics.js and
 * GA's `cookieDomain: 'auto'` do: try the shortest parent first and keep the
 * first one the browser accepts. The browser refuses public suffixes
 * (`co.uk`, `vercel.app`, `herokuapp.com`), so no suffix list ships in the
 * bundle — those fall through to the next candidate, and a host with no
 * acceptable parent stays host-only.
 */

/** `false` = host-only (the pre-sharing behaviour); a string = that domain. */
export type CookieDomainOption = string | false | undefined;

/**
 * Domains to try for `hostname`, shortest first, ENDING WITH THE HOST ITSELF.
 * The host is a candidate because the site's own bare domain is the common
 * case: a landing page on `example.com` must write `Domain=example.com` to share
 * with `app.example.com` — without it the bare domain stayed host-only while
 * its subdomains shared, so the landing-to-app journey was still two
 * visitors, and forget-me there left the shared copy behind.
 */
export function parentDomains(hostname: string | undefined): string[] {
  // `|| ''`: a stubbed or embedded `location` without a hostname must cost
  // the visitor cookie sharing, never crash init().
  const host = (hostname || '').toLowerCase();
  // localhost, a bare intranet name, an IP literal: nothing to share across.
  if (!host.includes('.') || /^[\d.]+$|:/.test(host)) return [];
  const labels = host.split('.');
  const out: string[] = [];
  for (let i = labels.length - 2; i >= 0; i--) out.push(labels.slice(i).join('.'));
  return out;
}
