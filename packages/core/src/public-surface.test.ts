import { describe, expect, it } from 'vitest';
import * as core from './index.js';

// Audit S15: the root entry grew to ~66 runtime exports, most of them
// plumbing shared with @sentientui/react and @sentientui/snippet (block
// vocabularies, snapshot I/O, agent-UA tables). Removing them is a breaking
// change for 1.0; until then every root export is classified here, so a new
// one can't land without someone deciding which side it is on — and the
// PUBLIC list is exactly what the README documents as supported.

/** Supported for applications. Documented in README "Public API". */
const PUBLIC = [
  'init',
  'grantConsent',
  'isDoNotTrackEnabled',
  'deriveSessionSegment',
  'setCspNonce',
  'forgetVisitor',
  'renderPrePaintScript',
] as const;

/** Shared with the other SentientUI packages. No semver promise; leaves the
 *  root entry at 1.0. */
const INTERNAL = [
  'AGENT_INTENTS', 'BLOCK_ALIGNS', 'BLOCK_EMPHASES', 'BLOCK_FITS', 'BLOCK_GAPS', 'BLOCK_GRID_COLUMNS',
  'BLOCK_HEADING_LEVELS', 'BLOCK_JUSTIFIES', 'BLOCK_MAX_WIDTHS', 'BLOCK_PADS', 'BLOCK_RATIOS', 'BLOCK_SIZES',
  'BLOCK_SURFACES', 'BLOCK_TEXT_ALIGNS', 'BLOCK_TONES', 'BLOCK_WEIGHTS', 'CLICK_ID_KEYS', 'FORM_FIELD_KINDS',
  'FORM_INPUT_TYPES', 'LEGACY_SESSION_COOKIE_NAME', 'LOCAL_MODE_BANNER', 'MAX_BLOCK_ARMS', 'MAX_BLOCK_CHILDREN',
  'MAX_BLOCK_DEPTH', 'MAX_BLOCK_NODES', 'MAX_BLOCK_TEXT_LEN', 'MAX_FORM_FIELDS', 'MAX_FORM_SELECT_OPTIONS',
  'MAX_SKELETON_LEAVES', 'MAX_SKELETON_NODES', 'MAX_SKELETON_TEXT', 'PAGE_SCOPE_RE', 'PROD_KEYLESS_ERROR',
  'REVEAL_MS', 'SNAPSHOT_STORAGE_KEY_PREFIX', '_registerConsentUpgradeInit', 'agentIntent', 'agentUaList',
  'applyNonce', 'armOfResult', 'attachMicroSignalDetectors', 'baselineResultFor', 'baselineSlots',
  'classifiedAgents', 'containsFormBlock', 'cspNonce', 'detectDeviceClass', 'detectTimeOfDay',
  'detectTrafficSource', 'extractTrackedParams', 'matchedAgentToken', 'pageScopeMatches', 'readSnapshot',
  'referrerDomainFromReferer', 'resetRevealStyles', 'reveal', 'sessionCookieName',
  'toWireSlot', 'uaTokenMatch', 'writeSnapshot', 'routeKey', 'forgetGeneration',
] as const;

describe('@sentientui/core root exports', () => {
  it('every runtime export is classified public or internal — nothing new slips in', () => {
    const actual = Object.keys(core).sort();
    expect(actual).toEqual([...PUBLIC, ...INTERNAL].sort());
  });

  it('the README documents exactly the public list', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');
    // The supported list: from the heading to the "Everything else" paragraph.
    const start = readme.indexOf('## Public API');
    const section = readme.slice(start, readme.indexOf('Everything else', start));
    for (const name of PUBLIC) expect(section, name).toContain(`\`${name}`);
    for (const name of INTERNAL) expect(section, name).not.toContain(`\`${name}\``);
  });
});
