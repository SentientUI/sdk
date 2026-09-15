/**
 * The adaptation reveal — the 0.X-second moment a visitor notices the page is
 * for them (`what-sentient-is-becoming.md` §"Fast generation and the wow",
 * where it is listed as the pending adaptation-visibility layer).
 *
 * THREE RULES, and the first two are the ones that make this shippable at all.
 *
 * 1. NEVER A CLOAK. The 2026-09-07 decision was explicit: nothing is hidden and
 *    then revealed. This animates from 55% opacity to full — the element is
 *    legible at every frame, so a visitor who arrives mid-animation reads real
 *    content rather than a blank space, and a failed script leaves a page that
 *    was never hidden in the first place. That rules out a true crossfade
 *    (which needs the old content held somewhere invisible) and it is the right
 *    trade: the point is to draw the eye to a change, not to conceal one.
 *
 * 2. ONLY ON A REAL, POST-PAINT CHANGE. A return visitor's arm is applied by
 *    the inline pre-paint tag, so the page was ALWAYS that way and there is
 *    nothing to reveal — animating it would be theatre, and worse, it would
 *    animate on every page load. The caller passes the text it is replacing;
 *    identical content animates nothing.
 *
 * 3. REDUCED MOTION WINS, unconditionally. Not a config option, not
 *    overridable: a vestibular trigger is not a growth experiment. Under
 *    `prefers-reduced-motion: reduce` the change still happens, instantly.
 *
 * The visitor-facing "shown because X" caption from the original sketch is
 * deliberately NOT here. Telling a customer's visitors that they are being
 * personalized is the customer's decision to make about their own site, not a
 * default we ship; the provenance is exposed as data attributes for devtools
 * and the editor instead.
 */

const STYLE_ID = 'sentient-reveal';
const CLASS = 'sentient-revealed';

/** Total motion. 240ms sits inside the 200–400ms the spec asks for: long enough
 *  to be seen, short enough that a visitor reading the line is not waiting. */
export const REVEAL_MS = 240;

let injected = false;

/** For tests and for `destroy()` — a second init must not stack sheets. */
export function resetRevealStyles(): void {
  injected = false;
  if (typeof document === 'undefined') return;
  document.getElementById(STYLE_ID)?.remove();
}

function ensureStyles(doc: Document): void {
  if (injected || doc.getElementById(STYLE_ID)) {
    injected = true;
    return;
  }
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  // The animation is defined ONLY inside the no-preference branch. Defining it
  // globally and disabling it under reduce would still leave the class applying
  // a transform on browsers that mis-report the query; this way the rule does
  // not exist for those users at all.
  style.textContent =
    `@media (prefers-reduced-motion: no-preference){` +
    `@keyframes ${CLASS}{from{opacity:.55;transform:translateY(2px)}to{opacity:1;transform:none}}` +
    `.${CLASS}{animation:${CLASS} ${REVEAL_MS}ms cubic-bezier(.2,.6,.2,1) both}}`;
  doc.head.appendChild(style);
  injected = true;
}

export type RevealOptions = {
  /** Text the element showed BEFORE the change. Identical text reveals nothing. */
  previous?: string | null;
  /** The arm now serving, exposed for devtools/editor — never rendered. */
  arm?: string;
  /** Why it was chosen. Same: data, not visible copy. */
  persona?: string;
  doc?: Document;
};

/**
 * Animate `el` as having just changed, and record what it changed to.
 *
 * Returns true when motion was applied — false when there was nothing to
 * reveal, which callers can treat as "the page already looked like this".
 */
export function reveal(el: Element, opts: RevealOptions = {}): boolean {
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!doc || !(el instanceof Element)) return false;

  // Provenance first: it is useful even when no motion runs (a pre-paint apply
  // still wants to say which arm it applied), so it is not inside the guard.
  if (opts.arm !== undefined) el.setAttribute('data-sentient-arm', opts.arm);
  if (opts.persona !== undefined) el.setAttribute('data-sentient-persona', opts.persona);

  // Rule 2. `previous === undefined` means the caller did not track it and is
  // asserting a change; an explicit equal value means there was none.
  if (opts.previous !== undefined && opts.previous === el.textContent) return false;

  ensureStyles(doc);
  // Restart the animation if the element is revealed twice in quick succession
  // (a persona upgrade landing on top of a first decide): removing the class
  // and forcing a reflow is the standard way to replay a CSS animation.
  el.classList.remove(CLASS);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(CLASS);

  const done = (): void => {
    el.classList.remove(CLASS);
    el.removeEventListener('animationend', done);
  };
  el.addEventListener('animationend', done);
  return true;
}
