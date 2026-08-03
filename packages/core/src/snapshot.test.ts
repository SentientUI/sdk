import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SNAPSHOT_STORAGE_KEY_PREFIX,
  readSnapshot,
  writeSnapshot,
  renderPrePaintScript,
  type DecisionSnapshot,
} from './snapshot.js';

const API_KEY = 'pk_test_abc123';

function validSnap(): DecisionSnapshot {
  return {
    v: 1,
    persona: 'buyer',
    band: 'high',
    slots: { hero: { tone: 'urgent' }, 'pricing-area': 'social_first' },
    layoutOrder: ['pricing', 'hero'],
    savedAt: 1234567890,
  };
}

function resetHtmlAttrs(): void {
  document.documentElement.removeAttribute('data-sentient-persona');
  document.documentElement.removeAttribute('data-sentient-confidence');
}

beforeEach(() => {
  localStorage.clear();
  resetHtmlAttrs();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetHtmlAttrs();
});

describe('readSnapshot / writeSnapshot', () => {
  it('round-trips a snapshot keyed by api key', () => {
    writeSnapshot(API_KEY, validSnap());
    expect(localStorage.getItem(SNAPSHOT_STORAGE_KEY_PREFIX + API_KEY)).toBeTruthy();
    expect(readSnapshot(API_KEY)).toEqual(validSnap());
    expect(readSnapshot('pk_other')).toBeNull();
  });

  it('returns null for corrupt JSON', () => {
    localStorage.setItem(SNAPSHOT_STORAGE_KEY_PREFIX + API_KEY, '{not json');
    expect(readSnapshot(API_KEY)).toBeNull();
  });

  it('returns null for wrong version or malformed shapes', () => {
    const bad = [
      { ...validSnap(), v: 2 },
      { ...validSnap(), persona: 42 },
      { ...validSnap(), band: 'huge' },
      { ...validSnap(), slots: 'nope' },
      { ...validSnap(), slots: ['nope'] },
      { ...validSnap(), layoutOrder: 'hero' },
      { ...validSnap(), savedAt: 'yesterday' },
      null,
      'a string',
    ];
    for (const snap of bad) {
      localStorage.setItem(SNAPSHOT_STORAGE_KEY_PREFIX + API_KEY, JSON.stringify(snap));
      expect(readSnapshot(API_KEY), JSON.stringify(snap)).toBeNull();
    }
  });

  it('swallows storage write failures (private mode / quota)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => writeSnapshot(API_KEY, validSnap())).not.toThrow();
  });
});

describe('renderPrePaintScript', () => {
  it('sets both html attributes from the stored snapshot when evaluated', () => {
    writeSnapshot(API_KEY, validSnap());
    (0, eval)(renderPrePaintScript(API_KEY));
    expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('buyer');
    expect(document.documentElement.getAttribute('data-sentient-confidence')).toBe('high');
  });

  it('does nothing when there is no snapshot', () => {
    (0, eval)(renderPrePaintScript(API_KEY));
    expect(document.documentElement.hasAttribute('data-sentient-persona')).toBe(false);
    expect(document.documentElement.hasAttribute('data-sentient-confidence')).toBe(false);
  });

  it('does nothing when the snapshot is corrupt', () => {
    localStorage.setItem(SNAPSHOT_STORAGE_KEY_PREFIX + API_KEY, '{broken');
    expect(() => (0, eval)(renderPrePaintScript(API_KEY))).not.toThrow();
    expect(document.documentElement.hasAttribute('data-sentient-persona')).toBe(false);
  });

  it('never overwrites attributes that are already set (single-writer)', () => {
    document.documentElement.setAttribute('data-sentient-persona', 'researcher');
    document.documentElement.setAttribute('data-sentient-confidence', 'low');
    writeSnapshot(API_KEY, validSnap());
    (0, eval)(renderPrePaintScript(API_KEY));
    expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('researcher');
    expect(document.documentElement.getAttribute('data-sentient-confidence')).toBe('low');
  });

  it('is XSS-safe and serialization-safe: no raw </, no backticks, apiKey JSON-escaped', () => {
    const hostile = 'pk_"</script><script>alert(1)//';
    const script = renderPrePaintScript(hostile);
    expect(script).not.toContain('</');       // cannot terminate an inline <script>
    expect(script).not.toContain('`');        // survives template-literal renderers
    expect(script).toContain('\\u003c');      // '<' escaped via the JSON path
    expect(() => (0, eval)(script)).not.toThrow(); // still valid JS
  });
});
