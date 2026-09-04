import { describe, it, expect } from 'vitest';
import { cssValueSafe } from './css-guard';

// Direct unit tests for the shared guard module. ops.test.ts covers the url()
// and empty-string rejections through applyOps; these pin the guard itself so
// BOTH consumers (runtime ops engine and on-site editor) are protected — the
// whole point of css-guard.ts is that the two copies had already diverged once.
describe('cssValueSafe — declaration-block escape', () => {
  it('rejects any value containing ; { } < or >', () => {
    // `;` ends the declaration: everything after it becomes attacker-chosen
    // CSS (here, an external fetch via background:url) inside the generated
    // !important sheet.
    expect(cssValueSafe('red; background:url(evil)')).toBe(false);
    // `}` closes the rule (and `<` opens markup): a stored style op could walk
    // out of the <style data-sentient-ops> element entirely.
    expect(cssValueSafe('red}</style><script>')).toBe(false);
    expect(cssValueSafe('{color:red}')).toBe(false);
    expect(cssValueSafe('1px < 2px')).toBe(false);
    expect(cssValueSafe('a > b')).toBe(false);
  });

  it('rejects each escape character even when the rest of the value is benign', () => {
    for (const ch of [';', '{', '}', '<', '>']) {
      expect(cssValueSafe(`10px${ch}`)).toBe(false);
    }
  });
});

describe('cssValueSafe — function allow-list is case-insensitive both ways', () => {
  it('rejects url() regardless of case (CSS function names are case-insensitive)', () => {
    // The browser treats URL(...) exactly like url(...) — a case-sensitive
    // guard would be a one-character bypass of the external-resource block.
    expect(cssValueSafe('url(https://tracker/x.png)')).toBe(false);
    expect(cssValueSafe('URL(https://tracker/x.png)')).toBe(false);
    expect(cssValueSafe('Url(https://tracker/x.png)')).toBe(false);
    expect(cssValueSafe('IMAGE-SET("https://tracker/y.png" 1x)')).toBe(false);
  });

  it('allows the safe functions regardless of case, symmetrically', () => {
    // The allow-list carries /i: RGB() must not be rejected while rgb() passes,
    // or a stylesheet authored with uppercase notation silently loses rules.
    expect(cssValueSafe('rgb(1,2,3)')).toBe(true);
    expect(cssValueSafe('RGB(1,2,3)')).toBe(true);
    expect(cssValueSafe('CALC(100% - 2px)')).toBe(true);
  });

  it('fails closed on a bare `(` with no recognisable function name before it', () => {
    // `url (x)` puts whitespace between the name and the paren, so the scan
    // captures an empty function name. That empty name must fail the
    // allow-list (fail closed), not be treated as anonymous-and-safe.
    expect(cssValueSafe('url (https://tracker/x.png)')).toBe(false);
  });
});

describe('cssValueSafe — nested allowed functions', () => {
  it('accepts allow-listed functions nested inside each other', () => {
    // The scan matches every `(` in the value, not just the first: nesting
    // must neither bypass the guard nor false-positive on legitimate values.
    expect(cssValueSafe('calc(var(--x))')).toBe(true);
    expect(cssValueSafe('clamp(1rem, calc(2vw + var(--pad)), 3rem)')).toBe(true);
    expect(cssValueSafe('rgba(var(--r), 0, 0, 0.5)')).toBe(true);
  });

  it('rejects a forbidden function hidden inside an allowed one', () => {
    // Only checking the outermost function would let calc() smuggle url().
    expect(cssValueSafe('calc(url(https://tracker/x.png))')).toBe(false);
    expect(cssValueSafe('min(url(evil), 10px)')).toBe(false);
  });

  it('still accepts plain function-free values', () => {
    expect(cssValueSafe('#0B5')).toBe(true);
    expect(cssValueSafe('0 2px 8px #00000033')).toBe(true);
    expect(cssValueSafe('Georgia, serif')).toBe(true);
  });
});
