import { describe, expect, it } from 'vitest';
import { hashLayout } from './hash';

// Parity fixtures computed with the current production implementation in
// apps/api/src/domain/layout-rewards.ts:
//   createHash('sha256').update(order.join('|')).digest('hex').slice(0, 16)
// These pin byte-compatibility with every layout_hash already stored in
// layout_weights. Do not regenerate them from this package's own output.
describe('hashLayout parity with apps/api layout-rewards.ts', () => {
  it('byte-matches the legacy hash for fixture vectors', () => {
    expect(hashLayout([])).toBe('e3b0c44298fc1c14');
    expect(hashLayout(['hero'])).toBe('ae6c79d10f1fd410');
    expect(hashLayout(['hero', 'pricing', 'cta'])).toBe('df226d891bdb1937');
    expect(hashLayout(['pricing', 'hero', 'cta'])).toBe('5cee4a1fe9f2a05b');
    expect(hashLayout(['hero', 'features', 'pricing', 'comparison'])).toBe('6c131920ee1abebe');
    expect(hashLayout(['pricing', 'hero', 'comparison', 'features'])).toBe('448bbf0f40e359a3');
  });

  it('is order-sensitive and returns 16 lowercase hex chars', () => {
    expect(hashLayout(['hero', 'pricing'])).not.toBe(hashLayout(['pricing', 'hero']));
    expect(hashLayout(['hero'])).toMatch(/^[a-f0-9]{16}$/);
  });

  it('documents the known join ambiguity for ids containing "|"', () => {
    // ['a','b|c'] and ['a|b','c'] both join to 'a|b|c'. Section ids never
    // contain '|' in practice; pinned so any future change is a conscious one.
    expect(hashLayout(['a', 'b|c'])).toBe(hashLayout(['a|b', 'c']));
  });
});
