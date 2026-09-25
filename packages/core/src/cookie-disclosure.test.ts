// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionCookieName } from './storage-key.js';
import { SNAPSHOT_STORAGE_KEY_PREFIX } from './snapshot.js';
import { retryStorageKey } from './queue.js';
import { goalRetryStorageKey } from './goal-queue.js';

// Audit S5: SDK_COOKIE_DISCLOSURE.md named a cookie the SDK no longer set, a
// 30-day lifetime for a 365-day cookie, an API that doesn't exist, and missed
// half the storage keys. Merchants paste it into their cookie notices, so a
// key added in code must fail here until the disclosure lists it.

// Run from packages/core (vitest's cwd for this workspace).
const SRC = resolve(process.cwd(), 'src');
const doc = readFileSync(resolve(SRC, '../../../SDK_COOKIE_DISCLOSURE.md'), 'utf8');
const src = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');
const K = 'pk_live_abcdefgh';
const shown = (key: string) => key.replace(`_${K.slice(0, 12)}`, '_<key>');

/** Every non-test source file of the three browser SDKs. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      const full = resolve(dir, f);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(f) && !/\.test\.|\.sim\./.test(f)) out.push(readFileSync(full, 'utf8'));
    }
  };
  for (const pkg of ['core', 'react', 'snippet']) walk(resolve(SRC, `../../${pkg}/src`));
  return out;
}

describe('SDK_COOKIE_DISCLOSURE.md', () => {
  it('names every storage key family found in the SDK source — found, not listed by hand', () => {
    const families = new Set<string>();
    for (const text of sources()) {
      for (const m of text.matchAll(/['"`](_{1,2}snt_[a-z_]+?)(?=_?\$\{|:|['"`])/g)) families.add(m[1]!.replace(/_$/, ''));
    }
    // The walk must actually see the known families, or it proves nothing.
    expect([...families]).toEqual(expect.arrayContaining(['_snt_uid', '_snt_retry', '_snt_goal_retry', '_snt_asgn', '_snt_graph_nodes', '_snt_fired_goals', '__snt_editor_token']));
    for (const f of families) expect(doc, `${f} is stored by the SDK but not disclosed`).toContain(f);
  });

  it('lists every key the SDKs write, under its real name', () => {
    for (const key of [
      shown(sessionCookieName(K)),
      shown(retryStorageKey(K)),
      shown(goalRetryStorageKey(K)),
      `${SNAPSHOT_STORAGE_KEY_PREFIX}<full pk_ key>`,
      '_snt_asgn_<key>_*',
      '_snt_graph_nodes_<key>',
      '_snt_uid_tomb_<key>',
      '_snt_fired_goals_<key>',
      '__snt_editor_token',
    ]) {
      expect(doc, key).toContain(`\`${key}\``);
    }
  });

  it('the listed name patterns are the ones in code', () => {
    expect(src('./cache.ts')).toContain('`_snt_asgn${storageSuffix(apiKey)}_`');
    expect(src('./graph.ts')).toContain('`_snt_graph_nodes${storageSuffix(config?.apiKey)}`');
    expect(src('./session.ts')).toContain('`${STORAGE_KEY}_tomb${suffix}`');
    expect(src('../../snippet/src/goal-wiring.ts')).toContain('`_snt_fired_goals_${apiKey.slice(0, 12)}`');
    expect(src('../../snippet/src/editor-token.ts')).toContain("'__snt_editor_token'");
    expect(src('../../react/src/editor-session.ts')).toContain("'__snt_editor_token'");
  });

  it('states the real cookie lifetime and no API that does not exist', () => {
    expect(src('./session.ts')).toMatch(/DEFAULT_COOKIE_TTL_DAYS = 365;/);
    expect(doc).toContain('365 days');
    expect(doc).not.toMatch(/setConsent\(|cookieTTLDays|30 days \(configurable\)|essential/i);
  });
});
