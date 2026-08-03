import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInit } from './init.js';

export function parseArgs(argv: string[]): { command: string | undefined; key?: string } {
  const args = [...argv];
  const command = args.shift();
  let key: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // Support both the space-separated (--key pk_...) and inline (--key=pk_...) forms.
    if (arg === '--key') {
      key = args[i + 1];
      i++;
    } else if (arg.startsWith('--key=')) {
      key = arg.slice('--key='.length);
    }
    // --yes / -y accepted for npx muscle memory; v1 has no prompts, so it is
    // also the default behavior (YAGNI: no prompt library).
  }
  return { command, key };
}

export function main(argv: string[]): void {
  const { command, key } = parseArgs(argv);

  if (command === 'init') {
    try {
      runInit({ cwd: process.cwd(), key });
    } catch (err) {
      console.error(`[sentientui] init failed: ${String(err)}`);
      process.exit(1);
    }
  } else {
    console.log('Usage: npx @sentientui/cli init [--key pk_...] [--yes]');
    process.exit(command ? 1 : 0);
  }
}

/** True only when this module is the process entry point (the published bin),
 *  not when it's imported by a test. Keeps importing parseArgs side-effect-free. */
function isRunAsScript(): boolean {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isRunAsScript()) {
  main(process.argv.slice(2));
}
