import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInit } from './init.js';

/** Kept in sync with package.json by the build; see tsup.config.ts `define`. */
declare const __CLI_VERSION__: string;

const VERSION = typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : '0.0.0-dev';

const USAGE = `SentientUI CLI — adaptive UI personalization for the web

Usage
  npx @sentientui/cli <command> [options]

Commands
  init                 Set up SentientUI in an existing React app: detect the
                       framework (Next.js App/Pages Router, Vite, Remix, CRA),
                       install @sentientui/react, write .env.local, and scaffold
                       an example component.

Options
  --key <pk_...>       Publishable API key to write into .env.local. Omit it to
                       use keyless local mode, which returns deterministic
                       simulated decisions and needs no account.
  --yes, -y            Accept defaults without prompting (the default today).
  --help, -h           Show this help.
  --version, -v        Print the CLI version.

Notes
  init does NOT edit your layout. It prints the snippet — you must wrap your app
  in <AdaptiveRoot> yourself, or nothing adapts and nothing is tracked.

  Verify an install by loading the app with ?sentient_persona=buyer and then
  ?sentient_persona=deal_seeker; the two should render differently.

Docs   https://sentient-ui.com/docs/developers#cli
API    https://api.sentient-ui.com/openapi.json`;

export function parseArgs(argv: string[]): {
  command: string | undefined;
  key?: string;
  help?: boolean;
  version?: boolean;
} {
  const args = [...argv];
  const command = args.shift();
  let key: string | undefined;
  // `--help` in the command slot is a flag, not an unknown command — otherwise
  // the one thing every user and every agent tries first exits non-zero.
  let help = command === '--help' || command === '-h';
  let version = command === '--version' || command === '-v';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // Support both the space-separated (--key pk_...) and inline (--key=pk_...) forms.
    if (arg === '--key') {
      key = args[i + 1];
      i++;
    } else if (arg.startsWith('--key=')) {
      key = arg.slice('--key='.length);
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-v') {
      version = true;
    }
    // --yes / -y accepted for npx muscle memory; v1 has no prompts, so it is
    // also the default behavior (YAGNI: no prompt library).
  }
  return { command, key, help, version };
}

export function main(argv: string[]): void {
  const { command, key, help, version } = parseArgs(argv);

  // Both are successful requests for information, so both exit 0 and print to
  // stdout — a script that pipes `--version` must not have to read stderr.
  if (version) {
    console.log(VERSION);
    return;
  }
  if (help) {
    console.log(USAGE);
    return;
  }

  if (command === 'init') {
    try {
      runInit({ cwd: process.cwd(), key });
    } catch (err) {
      console.error(`[sentientui] init failed: ${String(err)}`);
      process.exit(1);
    }
  } else {
    // An unknown command is an error (stderr, exit 1); no command at all is
    // someone asking what this is (stdout, exit 0).
    if (command) {
      console.error(`[sentientui] unknown command: ${command}\n`);
      console.error(USAGE);
      process.exit(1);
    }
    console.log(USAGE);
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
