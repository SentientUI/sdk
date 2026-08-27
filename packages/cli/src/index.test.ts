import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { main, parseArgs } from './index.js';

describe('parseArgs', () => {
  it('parses the space-separated --key form', () => {
    expect(parseArgs(['init', '--key', 'pk_live_abc'])).toMatchObject({
      command: 'init',
      key: 'pk_live_abc',
    });
  });

  it('parses the inline --key=value form', () => {
    expect(parseArgs(['init', '--key=pk_live_abc'])).toMatchObject({
      command: 'init',
      key: 'pk_live_abc',
    });
  });

  it('handles --key=value with an empty value', () => {
    expect(parseArgs(['init', '--key='])).toMatchObject({ command: 'init', key: '' });
  });

  it('returns no key when the flag is absent', () => {
    expect(parseArgs(['init'])).toMatchObject({ command: 'init', key: undefined });
  });

  it('ignores unknown flags like --yes', () => {
    expect(parseArgs(['init', '--yes', '--key=pk_x'])).toMatchObject({
      command: 'init',
      key: 'pk_x',
    });
  });

  // `--help` used to land in the command slot and be treated as an unknown
  // command, so the first thing anyone types exited 1.
  it.each([['--help'], ['-h']])('reads %s in the command slot as a flag', (flag) => {
    expect(parseArgs([flag])).toMatchObject({ help: true });
  });

  it.each([['--version'], ['-v']])('reads %s in the command slot as a flag', (flag) => {
    expect(parseArgs([flag])).toMatchObject({ version: true });
  });

  it('reads --help after a command too', () => {
    expect(parseArgs(['init', '--help'])).toMatchObject({ command: 'init', help: true });
  });
});

describe('main', () => {
  let out: string[];
  let err: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    out = [];
    err = [];
    exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation((msg) => void out.push(String(msg)));
    vi.spyOn(console, 'error').mockImplementation((msg) => void err.push(String(msg)));
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
      // Real process.exit never returns; throwing keeps the rest of the branch
      // from running, which is what the production control flow assumes.
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it('prints usage to stdout and exits successfully for --help', () => {
    main(['--help']);
    expect(exitCode).toBeUndefined();
    expect(out.join('\n')).toContain('Usage');
    expect(err).toEqual([]);
  });

  it('documents init, the key flag, and keyless mode in the help text', () => {
    main(['--help']);
    const help = out.join('\n');
    for (const fragment of ['init', '--key', 'keyless local mode', 'sentient-ui.com/docs/developers']) {
      expect(help, fragment).toContain(fragment);
    }
  });

  it('prints a bare version string for --version', () => {
    main(['--version']);
    expect(exitCode).toBeUndefined();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints usage on stdout with no command at all', () => {
    main([]);
    expect(exitCode).toBeUndefined();
    expect(out.join('\n')).toContain('Usage');
  });

  it('sends an unknown command to stderr and exits 1', () => {
    expect(() => main(['frobnicate'])).toThrow('process.exit');
    expect(exitCode).toBe(1);
    expect(err.join('\n')).toContain('unknown command: frobnicate');
    expect(out).toEqual([]);
  });
});
