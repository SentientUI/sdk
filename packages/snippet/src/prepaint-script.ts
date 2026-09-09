/**
 * The snippet install's inline pre-paint script — the middle tag of the
 * three-tag install, and the only SentientUI code that runs before the page
 * paints on a return visit.
 *
 * It lives here rather than in @sentientui/core because it is an artefact of the
 * SNIPPET install specifically: it reads `window.sentient`, it hands off to this
 * bundle through `window.__sntPP`, and its contract version is this package's to
 * keep. Core owns the snapshot format it reads; nothing else is shared.
 *
 * Design: docs/superpowers/specs/2026-09-07-snippet-prepaint-script-design.md
 */

/**
 * What the inline pre-paint script leaves behind for the bundle. The bundle must
 * tolerate this being absent (a two-tag install), a HIGHER `v` (a newer inline
 * pasted before the bundle updated — read only the fields you know), and
 * malformed (treat as absent).
 */
export type PrePaintRecord = {
  v: number;
  /** Date.now() when the inline script ran. */
  at: number;
  /** [element, attribute, value before we stamped it] — null means "absent". */
  stamped: Array<[Element, string, string | null]>;
  /** <html> attribute names the inline script set (empty when it set none). */
  html: string[];
  reordered: boolean;
  /** True once the observer is disconnected. */
  done: boolean;
  /** Disconnect now — the bundle has taken over. */
  stop(): void;
};

/** Contract version of the snippet inline pre-paint script — mirrored at runtime
 *  as `window.__sntPP.v`, and reported to /v1/decide as `pp` so the dashboard can
 *  tell a two-tag install from a three-tag one. The script is pasted into a site
 *  once and never floats, so v1 must stay supported by the bundle indefinitely. */
export const SNIPPET_PREPAINT_VERSION = 1;

/**
 * Snippet-install inline pre-paint script (v1).
 *
 * The snippet loader is `defer`, so the bundle's snapshot pass is pre-*decide*
 * but not necessarily pre-*paint*: on a return visit a page can show its natural
 * section order and baseline dims and then restamp. This script closes that gap
 * with zero network — it reads the snapshot the visitor's own prior visit wrote
 * and applies the reversible subset (persona attributes, slot attributes, the
 * cached section order) as the parser inserts the elements, before they paint.
 * It is a CONSTANT — it reads `window.sentient` at runtime instead of baking the
 * key in, so the dashboard install page, the README and the Shopify Liquid embed
 * all inline the same bytes and a test can pin them.
 *
 * Safety properties (pinned by tests):
 * - No interpolation at all, so nothing a hostile config value could reach.
 * - Built by string concatenation and contains no backticks, so the output
 *   survives being embedded in template-literal-based renderers.
 * - Contains no `<` whatsoever (comparisons are written with `>` / `~indexOf`),
 *   so it cannot terminate the inline `<script>` in any parser state.
 * - Every path is inside one try/catch: any error leaves the DOM alone, and the
 *   bundle's authoritative pass corrects anything this got wrong (see the
 *   `__sntPP` reconcile in index.ts).
 *
 * What it deliberately does NOT do: no `textContent`, no ops stylesheet, no
 * `moveBefore`/`moveAfter`, no Composition-Block rendering, and no cloak of any
 * kind. Those either need the decide response to be trustworthy or need the
 * renderer that lives in the bundle.
 */
export function renderSnippetPrePaintScript(): string {
  return (
    '(function(){try{' +
    // --- Gates. Every one of these mirrors a short-circuit in the bundle's
    // run(), so the inline script can never apply where the bundle would not.
    'var W=window,D=document,N=navigator,L=W.location,c=W.sentient,n=Date.now();' +
    // Config shape + consent + the double-embed guard (GTM plus a hardcoded tag).
    'if(!c||typeof c.apiKey!="string"||c.consent===!1||W.__sntPP)return;' +
    // Same predicate as isDoNotTrackEnabled, plus automation: the bundle already
    // withholds structural changes from crawlers, and this has nothing to gain.
    'if(N.doNotTrack=="1"||N.globalPrivacyControl||N.webdriver)return;' +
    // Editor / preview / persona-preview must never show a stale state first.
    'if(/[?&]sentient_(editor|preview|persona)=/.test(L.search))return;' +
    // JSON.parse(null) is null, so a missing snapshot throws into the catch.
    'var s=JSON.parse(localStorage.getItem("_snt_snap:"+c.apiKey)),S=s.slots;' +
    // Shape checks mirror readSnapshot. The freshness test is written inverted
    // (`!(TTL > age)`) on purpose: a missing/garbage savedAt makes the age NaN,
    // every NaN comparison is false, and the negation turns that into a bail —
    // `age > TTL` alone would have let it through. 30 days = the visitor window;
    // an older snapshot is worth nothing and could name retired arms.
    'if(s.v!==1||typeof s.persona!="string"||typeof s.band!="string"||!S||typeof S!="object"||!(2592e6>n-s.savedAt))return;' +
    // --- Hand-off record read by the bundle (see reconcilePrePaint).
    'var H=["data-sentient-persona","data-sentient-confidence"],d=D.documentElement,' +
    'P=W.__sntPP={v:1,at:n,stamped:[],html:[],reordered:!1,done:!1,stop:function(){X()}},' +
    'b=P.stamped,p=[],i,k,t,e,l,m,x,V=c.sections,O=s.layoutOrder,' +
    // Reorder is retired up front unless both halves are present and agree in
    // length; `q` doubles as the once-only latch inside F.
    'q=!(V&&V.length>1&&O&&O.length==V.length);' +
    // (a) <html> persona attributes — renderPrePaintScript's job, folded in.
    // Single-writer: never overwrite attributes an SSR pass already set.
    'if(c.personaAttributes&&!d.hasAttribute(H[0])){d.setAttribute(H[0],s.persona);d.setAttribute(H[1],s.band);P.html=H}' +
    // Attribute-selector value escaping, same rule as resolveLocatorOne.
    'var Q=function(v){return(""+v).replace(/["\\\\]/g,"\\\\$&")},' +
    // A(selector, result, decl): queue (selector, attr, value) triples. With a
    // decl (page-declared slots) the value is checked against the declared space,
    // exactly like applySlotArms/applySlotAttributes; registry slots have no
    // client-side space to check against — the server owns it.
    'A=function(t,v,g){if(typeof v=="string"){if(!g||(g.arms||[]).indexOf(v)>-1)p.push([t,"data-sentient-arm",v])}' +
    'else if(v)for(k in v)if(!g||((g.dims||{})[k]||[]).indexOf(v[k])>-1)p.push([t,"data-"+k,v[k]])},' +
    // U(triple): undo one stamp and drop it from the hand-off record.
    'U=function(t){var a=t[3];if(!a)return;a[2]==null?a[0].removeAttribute(a[1]):a[0].setAttribute(a[1],a[2]);' +
    'x=b.indexOf(a);if(x>-1)b.splice(x,1);t[3]=0},' +
    // R(): the section reorder. Hand-minified copy of planReorder() in
    // ./layout-order.ts — the drift test in layout-order.test.ts runs both
    // against one fixture table. Returns 1 to retire (applied, or provably
    // never applicable) and 0 to keep waiting for
    // the parser. All selectors must resolve uniquely, to distinct elements
    // sharing one parent, and the order must be exactly a permutation of them.
    'R=function(){var g={},f=[],y,z,a,n=0;' +
    'for(i in V){try{y=D.querySelectorAll(V[i])}catch(_){return 1}if(y.length==1){g[V[i]]=y[0];n++}}' +
    'if(n!=V.length)return 0;' +
    'for(i in O){z=g[O[i]];if(!z||~f.indexOf(z))return 1;f.push(z)}' +
    'a=f[0].parentNode;if(!a)return 1;for(i in f)if(f[i].parentNode!=a)return 1;' +
    'y=f.slice().sort(function(u,v){return u.compareDocumentPosition(v)&4?-1:1});' +
    'for(i=0;i in f;i++){z=f[i];if(y[i]!=z){a.insertBefore(z,y[i]);y.splice(y.indexOf(z),1);y.splice(i,0,z)}}' +
    'P.reordered=!0;return 1},' +
    // F(): one observer batch. Body elements do not exist when a head script
    // runs, so targets are stamped as the parser inserts them. Exactly one match
    // stamps; more than one UNSTAMPS and retires the triple (the registry "no
    // guess" rule applied mid-parse — a selector that resolves to one element
    // early and two later is ambiguous, and the bundle decides). An invalid
    // selector retires silently.
    'F=function(){if(P.done)return;for(i=0;i in p;i++){t=p[i];if(!t)continue;' +
    'try{m=D.querySelectorAll(t[0])}catch(_){p[i]=0;continue}' +
    'if(m.length>1){U(t);p[i]=0}' +
    'else if(m.length==1&&(!t[3]||t[3][0]!=m[0])){U(t);e=m[0];t[3]=[e,t[1],e.getAttribute(t[1])];e.setAttribute(t[1],t[2]);b.push(t[3])}}' +
    'if(!q)q=R()},' +
    // X(): stop observing. DOMContentLoaded (the parser is done — anything later
    // is the bundle's job), the bundle calling stop(), or the 3s hard cap so a
    // page that never reaches DOMContentLoaded cannot keep an observer alive.
    'X=function(){if(P.done)return;P.done=!0;try{o.disconnect()}catch(_){}clearTimeout(T)},' +
    // (b) the two sources of (selector, attributes) pairs.
    'G=c.slots,C=s.slotConfig;' +
    'for(i in G)if(G[i]&&G[i].target)A(G[i].target,S[i],G[i]);' +
    // Registry slots: the locator reduced to its STRUCTURAL parts only. The
    // fingerprint (tag/text) cannot be checked before children parse, so it is
    // skipped and the bundle verifies it; urlMatch is honoured (same compare as
    // isUrlScopedOut). Attributes only — never content or ops.
    'for(i in C){e=C[i]||{};l=e.locator;t=e.target;' +
    'if(l){if(l.urlMatch&&!~L.pathname.indexOf(l.urlMatch))continue;' +
    't=l.id?\'[id="\'+Q(l.id)+\'"]\':l.dataAttr&&/^[\\w-]+$/.test(l.dataAttr.name)?"["+l.dataAttr.name+\'="\'+Q(l.dataAttr.value)+\'"]\':l.selector}' +
    'if(t)A(t,S[i])}' +
    'var o=new MutationObserver(F),T=setTimeout(X,3e3);' +
    'o.observe(d,{childList:!0,subtree:!0});' +
    // One final pass at DOMContentLoaded catches anything inserted in the last
    // batch, then the observer goes away.
    'D.addEventListener("DOMContentLoaded",function(){F();X()});F();' +
    '}catch(_){}})();'
  );
}
