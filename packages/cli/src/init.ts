import { execSync } from 'node:child_process';
import { detectFramework, detectPackageManager, installCommand, type Framework } from './detect.js';
import { writeEnvFile, envVarName } from './env-file.js';
import { scaffoldExample } from './scaffold.js';
import { wrapSnippet, unknownInstructions, finale } from './snippets.js';
import { assertPublishableKey } from './validate-key.js';

export type InitOptions = {
  cwd: string;
  /** From --key. Written into .env.local; omitted = empty value (local mode). */
  key?: string;
  /** Injectable for tests. Defaults to execSync with stdio: 'inherit'. */
  exec?: (command: string, cwd: string) => void;
  /** Injectable for tests. Defaults to console.log. */
  log?: (line: string) => void;
};

export function runInit(opts: InitOptions): { framework: Framework } {
  const log = opts.log ?? ((line: string) => console.log(line));
  const exec =
    opts.exec ?? ((command: string, cwd: string) => execSync(command, { cwd, stdio: 'inherit' }));

  // ABORT before doing anything if the key would leak a secret into
  // client-exposed env. This throws (caught by main() → non-zero exit) rather
  // than warning-then-writing, so `init --key sk_…` can never bundle a secret.
  assertPublishableKey(opts.key, log);

  const framework = detectFramework(opts.cwd);
  log(`[sentientui] detected framework: ${framework}`);

  if (framework === 'unknown') {
    log(unknownInstructions());
    return { framework };
  }

  const pm = detectPackageManager(opts.cwd);
  // Shell execution is safe here: the command is composed of fixed literals
  // only (never user input — --key goes to .env.local, not the shell), and a
  // shell is required on Windows to resolve npm.cmd/pnpm.cmd shims.
  const install = installCommand(pm, '@sentientui/react');
  log(`[sentientui] installing @sentientui/react (${install})`);
  exec(install, opts.cwd);

  const envResult = writeEnvFile(opts.cwd, framework, opts.key);
  log(
    `[sentientui] .env.local ${envResult}: ${envVarName(framework)}=${opts.key ?? '(empty — local mode)'}`,
  );

  const scaffolded = scaffoldExample(opts.cwd);
  log(
    scaffolded
      ? `[sentientui] scaffolded ${scaffolded}`
      : '[sentientui] adaptive-example.tsx already exists — left untouched',
  );

  log('');
  log('Wrap your app:');
  log(wrapSnippet(framework, envVarName(framework)));
  log('');
  log(`Then run your dev server and: ${finale(framework)}`);
  return { framework };
}
