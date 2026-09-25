// Credentials the dashboard hands the site (`sentient_preview_token`, the
// editor's one-time `sentient_editor_code`) ride the URL FRAGMENT, which is
// never sent over the network — no server/CDN log, no Referer (grades C13, E1).
//
// The fragment is also where hash-routed sites keep their route (grade E2).
// The first version wrote `#sentient_preview_token=…` over the whole hash, so a
// preview of `/#/pricing` opened the home route instead. The dashboard now
// APPENDS the param (appendHashParam in apps/dashboard/app/lib/hash-param.ts):
//   ''          → #name=v
//   '/pricing'  → #/pricing?name=v      (routers read it as a query param, so
//   '/p?x=1'    → #/p?x=1&name=v         the route still matches pre-strip)
// and this takes it back out, restoring the site's own hash EXACTLY — or
// removing the '#' altogether when the site had none. Twin of
// packages/snippet/src/hash-param.ts (the snippet cannot import this package
// and vice versa); keep the two in step — both suites run the same cases.
export function takeHashParam(name: string): string | null {
  let v: string | null = null;
  try {
    const h = location.hash.slice(1);
    const m = RegExp('(^|[?&])' + name + '=([^&]*)').exec(h);
    if (m) {
      // Taken BEFORE the rewrite: an opaque-origin frame may refuse
      // replaceState, and the value is still ours to use. Base64url, so no
      // decoding (the dashboard never percent-encodes it).
      v = m[2]!;
      let after = h.slice(m.index + m[0].length);
      // '?name=v&rest' / 'name=v&rest': the next param inherits the separator.
      if (m[1] != '&' && after[0] == '&') after = m[1] + after.slice(1);
      const rest = h.slice(0, m.index) + after;
      // replaceState, not location.hash=: no hashchange, so a hash router does
      // not re-route mid-boot; history.state kept so its entry key survives.
      history.replaceState(history.state, '', rest ? '#' + rest : location.pathname + location.search);
    }
  } catch {
    /* fail-safe */
  }
  return v;
}
