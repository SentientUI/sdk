import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Framework } from './detect.js';

export function envVarName(framework: Framework): string {
  switch (framework) {
    case 'cra':
      // Create React App only inlines env vars prefixed REACT_APP_.
      return 'REACT_APP_SENTIENT_API_KEY';
    case 'vite':
    case 'remix':
      // Vite (and Remix v2, which is Vite-powered) only exposes VITE_-prefixed
      // vars to the client via import.meta.env.
      return 'VITE_SENTIENT_API_KEY';
    case 'next-app':
    case 'next-pages':
    case 'unknown':
      // Next.js exposes NEXT_PUBLIC_-prefixed vars to the browser. 'unknown' never
      // reaches writeEnvFile (init bails earlier); it just needs a sane default.
      return 'NEXT_PUBLIC_SENTIENT_API_KEY';
  }
}

export type EnvWriteResult = 'created' | 'appended' | 'updated' | 'kept';

/**
 * Creates, appends to, or updates .env.local.
 *
 * Without an explicit key this never clobbers: an existing assignment of the
 * variable (even an empty or commented one) leaves the file byte-for-byte
 * untouched. An explicitly passed --key, though, expresses intent: this used
 * to return 'kept' for it too, so `init --key pk_…` after a keyless init left
 * the empty assignment in place — while init's log claimed the key was written
 * — and the app silently stayed in local mode. Now an explicit key overwrites
 * a differing active assignment in place ('updated'); 'kept' means the value
 * already matches.
 */
export function writeEnvFile(cwd: string, framework: Framework, key: string | undefined): EnvWriteResult {
  const varName = envVarName(framework);
  const file = path.join(cwd, '.env.local');
  const block = [
    '',
    '# SentientUI — leave empty for local mode (decisions are simulated on-device; nothing is sent)',
    `${varName}=${key ?? ''}`,
    '',
  ].join('\n');
  if (!existsSync(file)) {
    writeFileSync(file, block.trimStart(), 'utf-8');
    return 'created';
  }
  const existing = readFileSync(file, 'utf-8');
  // varName is one of our fixed literals (envVarName), so it is regex-safe.
  const activeRe = new RegExp(`^([\\t ]*${varName}=)([^\\r\\n]*)`, 'm');
  const commentedRe = new RegExp(`^[\\t ]*#+\\s*${varName}=`, 'm');
  const active = existing.match(activeRe);

  // `--key=` (explicit empty) is local mode, same as no flag — it must not
  // silently blank a key that is already configured.
  if (!key) {
    // A commented assignment still "claims" the var — appending an active
    // duplicate would be confusing and could shadow the user's intent — so we
    // leave the file untouched and let them un-comment it themselves.
    if (active || commentedRe.test(existing)) return 'kept';
    appendFileSync(file, block, 'utf-8');
    return 'appended';
  }

  if (active) {
    if (active[2]!.trim() === key) return 'kept';
    // Replacer function, not a replacement string: a key containing `$` would
    // otherwise be interpreted as a replacement pattern.
    writeFileSync(file, existing.replace(activeRe, (_m, prefix: string) => `${prefix}${key}`), 'utf-8');
    return 'updated';
  }
  // Only a commented-out assignment exists: append an active one rather than
  // editing a line the user wrote themselves.
  appendFileSync(file, block, 'utf-8');
  return 'appended';
}
