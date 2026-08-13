// Single source of truth for the bounded-style guard shared by the runtime ops
// engine (ops.ts) and the on-site editor (editor/index.ts). Previously each side
// hand-maintained its own copy of the whitelist + value guard, and they had
// DIVERGED (the editor rejected empty strings, the runtime did not — so a
// server-delivered `{color:''}` produced a degenerate `color: !important` rule).
// Keeping one copy here removes that class of drift. Importing this from ops.ts
// does not grow the always-on bundle: it's the same code, just relocated.

// camelCase whitelist → CSS property. Any key not here is ignored (defense in
// depth: the server validates too).
export const CSS_PROP: Record<string, string> = {
  color: 'color',
  background: 'background',
  fontSize: 'font-size',
  fontWeight: 'font-weight',
  textAlign: 'text-align',
  padding: 'padding',
  margin: 'margin',
  borderRadius: 'border-radius',
  width: 'width',
  height: 'height',
  maxWidth: 'max-width',
  border: 'border',
  boxShadow: 'box-shadow',
  opacity: 'opacity',
  lineHeight: 'line-height',
  letterSpacing: 'letter-spacing',
  textTransform: 'text-transform',
  gap: 'gap',
  fontFamily: 'font-family',
};

// CSS functions safe to keep: colour + math notations that can never load or
// reference an external resource. Anything else with a `(` — url(), image(),
// image-set(), cross-fade(), element(), gradients — is rejected so a stored style
// op can't fetch a remote asset (tracking pixel / mixed content) from a value.
const CSS_FN_ALLOW = /^(rgb|rgba|hsl|hsla|calc|var|min|max|clamp)$/i;

// A CSS value can never legitimately contain `;{}<>` (used to escape the
// declaration block). It also may not invoke any function outside the safe
// allow-list above (which would otherwise let `background:url(…)` load an
// external resource from a stored op). Empty/whitespace is rejected too: an empty
// value yields the degenerate `prop: !important` rule (a silent no-op that also
// blanks nothing but wastes a rule) and never represents an intended change.
export function cssValueSafe(v: string): boolean {
  if (v.trim().length === 0 || /[;{}<>]/.test(v)) return false;
  // Every `(` must be immediately preceded by an allow-listed function name.
  for (const m of v.matchAll(/([A-Za-z-]*)\(/g)) {
    if (!CSS_FN_ALLOW.test(m[1] ?? '')) return false;
  }
  return true;
}
