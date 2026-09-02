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

  it('accepts --yes / -y as a known no-op', () => {
    expect(parseArgs(['init', '--yes', '--key=pk_x'])).toMatchObject({
      command: 'init',
      key: 'pk_x',
      error: undefined,
    });
    expect(parseArgs(['init', '-y'])).toMatchObject({ command: 'init', error: undefined });
  });

  // `--key` used to swallow whatever token came next, so `init --key --yes`
  // silently used "--yes" as the API key.
  it('rejects an option-shaped value for --key', () => {
    expect(parseArgs(['init', '--key', '--yes'])).toMatchObject({
      command: 'init',
      key: undefined,
      error: expect.stringContaining('--key requires a value'),
    });
  });

  it('rejects a missing value for --key', () => {
    expect(parseArgs(['init', '--key'])).toMatchObject({
      error: expect.stringContaining('--key requires a value'),
    });
  });

  // A typo'd flag (`--kye pk_x`) used to be silently ignored, so init ran
  // keyless and the user thought their key was configured.
  it('rejects unknown flags instead of ignoring them', () => {
    expect(parseArgs(['init', '--kye', 'pk_x'])).toMatchObject({
      error: 'unknown option: --kye',
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

  it('exits 1 with the usage on an unknown option, before running anything', () => {
    expect(() => main(['init', '--kye', 'pk_x'])).toThrow('process.exit');
    expect(exitCode).toBe(1);
    expect(err.join('\n')).toContain('unknown option: --kye');
    expect(err.join('\n')).toContain('Usage');
    expect(out).toEqual([]);
  });

  it('exits 1 when --key is given an option-shaped value', () => {
    expect(() => main(['init', '--key', '--yes'])).toThrow('process.exit');
    expect(exitCode).toBe(1);
    expect(err.join('\n')).toContain('--key requires a value');
  });
});
