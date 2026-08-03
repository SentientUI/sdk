import { describe, it, expect } from 'vitest';
import { parseArgs } from './index.js';

describe('parseArgs', () => {
  it('parses the space-separated --key form', () => {
    expect(parseArgs(['init', '--key', 'pk_live_abc'])).toEqual({
      command: 'init',
      key: 'pk_live_abc',
    });
  });

  it('parses the inline --key=value form', () => {
    expect(parseArgs(['init', '--key=pk_live_abc'])).toEqual({
      command: 'init',
      key: 'pk_live_abc',
    });
  });

  it('handles --key=value with an empty value', () => {
    expect(parseArgs(['init', '--key='])).toEqual({ command: 'init', key: '' });
  });

  it('returns no key when the flag is absent', () => {
    expect(parseArgs(['init'])).toEqual({ command: 'init', key: undefined });
  });

  it('ignores unknown flags like --yes', () => {
    expect(parseArgs(['init', '--yes', '--key=pk_x'])).toEqual({
      command: 'init',
      key: 'pk_x',
    });
  });
});
