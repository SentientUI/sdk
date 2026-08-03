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

export type EnvWriteResult = 'created' | 'appended' | 'kept';

/**
 * Creates or appends to .env.local. Never clobbers: an existing assignment of
 * the variable (even an empty one) leaves the file byte-for-byte untouched.
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
  // Detect an existing assignment whether it is active OR commented out
  // (`# VAR=`). A commented assignment still "claims" the var — appending an
  // active duplicate would be confusing and could shadow the user's intent — so
  // we leave the file untouched and let them un-comment it themselves.
  const assigned = existing
    .split(/\r?\n/)
    .some((line) => line.trim().replace(/^#+\s*/, '').startsWith(`${varName}=`));
  if (assigned) return 'kept';
  appendFileSync(file, block, 'utf-8');
  return 'appended';
}
