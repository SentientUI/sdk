import { execSync } from 'node:child_process';
import { detectFramework, detectPackageManager, installCommand, type Framework } from './detect.js';
import { writeEnvFile, envVarName, envFileName } from './env-file.js';
import { scaffoldExample } from './scaffold.js';
import { wrapSnippet, unknownInstructions, finale, consentNote, type ConsentPreset } from './snippets.js';
import { assertPublishableKey } from './validate-key.js';

export type InitOptions = {
  cwd: string;
  /** From --key. Written into .env.local; omitted = empty value (local mode). */
  key?: string;
  /** From --consent: the consent platform the printed snippet waits for. */
  consent?: ConsentPreset;
  /** False with --no-install: print the install command instead of running it. */
  install?: boolean;
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
    log(unknownInstructions(opts.consent));
    log('');
    log(consentNote(opts.consent));
    return { framework };
  }

  const pm = detectPackageManager(opts.cwd);
  // Shell execution is safe here: the command is composed of fixed literals
  // only (never user input — --key goes to .env.local, not the shell), and a
  // shell is required on Windows to resolve npm.cmd/pnpm.cmd shims.
  const install = installCommand(pm, '@sentientui/react');
  if (opts.install === false) {
    // --no-install: for setups detection cannot get right (an unusual
    // workspace layout, a registry proxy, offline CI). Running a guessed
    // install in a workspace package is what broke `workspace:` deps before
    // the lockfile walk-up existed — this is the escape hatch for the rest.
    log(`[sentientui] skipped install (--no-install) — run it yourself: ${install}`);
  } else {
    log(`[sentientui] installing @sentientui/react (${install})`);
    exec(install, opts.cwd);
  }

  const envResult = writeEnvFile(opts.cwd, framework, opts.key);
  const envFile = envFileName(framework);
  // The log must say what actually happened: it used to print `VAR=<key>` even
  // when writeEnvFile kept a different existing value, so `init --key pk_…` on
  // an initialized repo claimed the key was written while the app silently
  // stayed on the old assignment.
  if (envResult === 'kept') {
    log(
      `[sentientui] ${envFile} kept: ${envVarName(framework)} is already set${
        opts.key ? ' to this key' : ''
      } — left untouched`,
    );
  } else {
    log(
      `[sentientui] ${envFile} ${envResult}: ${envVarName(framework)}=${opts.key ?? '(empty — local mode)'}`,
    );
  }

  const scaffolded = scaffoldExample(opts.cwd);
  log(
    scaffolded
      ? `[sentientui] scaffolded ${scaffolded}`
      : '[sentientui] adaptive-example.tsx already exists — left untouched',
  );

  log('');
  log('Wrap your app:');
  log(wrapSnippet(framework, envVarName(framework), opts.consent));
  log('');
  log(consentNote(opts.consent));
  log('');
  log(`Mount <AdaptiveExampleHero /> on a page, then run your dev server and ${finale(framework)}`);
  return { framework };
}
