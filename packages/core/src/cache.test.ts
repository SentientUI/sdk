import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssignmentCache, type Assignment } from './cache';

const assignment = (overrides: Partial<Assignment> = {}): Assignment => ({
  variantId: 'variant-a',
  assignedAt: Date.now(),
  segment: 'default',
  confidence: 0.9,
  ...overrides,
});

describe('createAssignmentCache', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('get returns null for missing', () => {
    const cache = createAssignmentCache();
    expect(cache.get('hero', 'default')).toBeNull();
  });

  it('get returns null for expired', () => {
    const cache = createAssignmentCache(1000);
    cache.set('hero', 'default', assignment({ assignedAt: Date.now() - 2000 }));
    expect(cache.get('hero', 'default')).toBeNull();
  });

  it('set/get round trip', () => {
    const cache = createAssignmentCache();
    const a = assignment({ variantId: 'v2' });
    cache.set('cta', 'mobile', a);
    expect(cache.get('cta', 'mobile')).toEqual(a);
  });

  it('localStorage persistence and restoration', () => {
    const cache1 = createAssignmentCache();
    cache1.set('pricing', 'us', assignment({ variantId: 'p-us' }));

    const cache2 = createAssignmentCache();
    expect(cache2.get('pricing', 'us')?.variantId).toBe('p-us');
  });

  it('invalidation clears both stores', () => {
    const cache = createAssignmentCache();
    cache.set('nav', 'a', assignment({ segment: 'a' }));
    cache.set('nav', 'b', assignment({ segment: 'b', variantId: 'v-b' }));
    cache.set('footer', 'a', assignment({ variantId: 'footer-v' }));

    cache.invalidate('nav');

    expect(cache.get('nav', 'a')).toBeNull();
    expect(cache.get('nav', 'b')).toBeNull();
    expect(cache.get('footer', 'a')?.variantId).toBe('footer-v');
    expect(localStorage.getItem('_snt_asgn_nav:a')).toBeNull();
  });
});

describe('createAssignmentCache — TTL boundary', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('entry exactly at expiry instant is still valid (strict < comparison)', () => {
    vi.setSystemTime(1_000_000);
    const ttl = 1000;
    const cache = createAssignmentCache(ttl);
    cache.set('hero', 'default', assignment({ assignedAt: Date.now() }));

    // assignedAt + ttl === now exactly → isExpired uses `<`, so NOT expired.
    vi.setSystemTime(1_000_000 + ttl);
    expect(cache.get('hero', 'default')).not.toBeNull();

    // One ms past the boundary → expired.
    vi.setSystemTime(1_000_000 + ttl + 1);
    expect(cache.get('hero', 'default')).toBeNull();
  });
});

describe('createAssignmentCache — storage failure & corruption resilience', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('set() falls back to memory-only when localStorage.setItem throws (quota exceeded)', () => {
    const cache = createAssignmentCache();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    const a = assignment({ variantId: 'mem-only' });
    expect(() => cache.set('hero', 'default', a)).not.toThrow();
    // Memory read still works.
    expect(cache.get('hero', 'default')).toEqual(a);
    // Nothing persisted to storage.
    expect(localStorage.getItem('_snt_asgn_hero:default')).toBeNull();
  });

  it('restoreFromStorage recovers and does not throw on corrupt JSON in storage', () => {
    localStorage.setItem('_snt_asgn_hero:default', '{not valid json');
    localStorage.setItem('_snt_asgn_cta:mobile', JSON.stringify(assignment({ variantId: 'good' })));

    // Constructing the cache runs restoreFromStorage which must skip the corrupt
    // entry and load the valid one without throwing.
    let cache!: ReturnType<typeof createAssignmentCache>;
    expect(() => { cache = createAssignmentCache(); }).not.toThrow();
    expect(cache.get('hero', 'default')).toBeNull(); // corrupt → not loaded
    expect(cache.get('cta', 'mobile')?.variantId).toBe('good');
  });

  it('invalidate() on a non-existent componentId does not throw and leaves others intact', () => {
    const cache = createAssignmentCache();
    cache.set('hero', 'default', assignment({ variantId: 'keep' }));
    expect(() => cache.invalidate('does-not-exist')).not.toThrow();
    expect(cache.get('hero', 'default')?.variantId).toBe('keep');
  });
});

describe('createAssignmentCache — storage-key parsing with underscores/colons', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('componentId containing underscores round-trips on restore', () => {
    const c1 = createAssignmentCache();
    c1.set('hero_section', 'mobile', assignment({ variantId: 'under-comp' }));

    const c2 = createAssignmentCache(); // restores from storage
    expect(c2.get('hero_section', 'mobile')?.variantId).toBe('under-comp');
  });

  it('a segment containing an underscore round-trips correctly on restore', () => {
    // The key encodes each part and joins with ':', so the original
    // (hero, us_west) pair is recovered exactly after a reload.
    const c1 = createAssignmentCache();
    c1.set('hero', 'us_west', assignment({ variantId: 'seg-under' }));
    expect(c1.get('hero', 'us_west')?.variantId).toBe('seg-under');

    const c2 = createAssignmentCache(); // restore parses the storage key
    expect(c2.get('hero', 'us_west')?.variantId).toBe('seg-under');
    // The previously mis-parsed key must NOT exist.
    expect(c2.get('hero_us', 'west')).toBeNull();
  });

  it('a segment containing a colon (e.g. device:source) round-trips on restore', () => {
    const c1 = createAssignmentCache();
    c1.set('hero', 'desktop:direct', assignment({ variantId: 'seg-colon' }));

    const c2 = createAssignmentCache();
    expect(c2.get('hero', 'desktop:direct')?.variantId).toBe('seg-colon');
    // invalidate must still match the component despite the colon in the segment.
    c2.invalidate('hero');
    const c3 = createAssignmentCache();
    expect(c3.get('hero', 'desktop:direct')).toBeNull();
  });
});

describe('createAssignmentCache — in-memory key collision', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('does not collide two distinct (id, segment) pairs that share a raw join', () => {
    // Under a raw `${id}:${segment}` join both of these key to 'a:b:c'. The
    // encoded key ('a%3Ab:c' vs 'a:b%3Ac') keeps them distinct.
    const cache = createAssignmentCache();
    cache.set('a:b', 'c', assignment({ variantId: 'first' }));
    cache.set('a', 'b:c', assignment({ variantId: 'second' }));

    expect(cache.get('a:b', 'c')?.variantId).toBe('first');
    expect(cache.get('a', 'b:c')?.variantId).toBe('second');

    // invalidate targets only the matching componentId, not the collided sibling.
    cache.invalidate('a:b');
    expect(cache.get('a:b', 'c')).toBeNull();
    expect(cache.get('a', 'b:c')?.variantId).toBe('second');
  });
});

describe('createAssignmentCache — per-entry TTL (server assignmentTtlMs)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a short per-entry ttlMs expires before the cache-wide default', () => {
    vi.setSystemTime(0);
    // Long default (30 min) but this entry carries a 1s server TTL.
    const cache = createAssignmentCache();
    cache.set('hero', 'default', assignment({ assignedAt: Date.now(), ttlMs: 1000 }));

    vi.setSystemTime(999);
    expect(cache.get('hero', 'default')).not.toBeNull();
    vi.setSystemTime(1001);
    expect(cache.get('hero', 'default')).toBeNull();
  });

  it('a long per-entry ttlMs survives past a short cache-wide default', () => {
    vi.setSystemTime(0);
    const cache = createAssignmentCache(500); // 500ms default
    cache.set('hero', 'default', assignment({ assignedAt: Date.now(), ttlMs: 100_000 }));

    // Well past the 500ms default — the per-entry TTL wins.
    vi.setSystemTime(2000);
    expect(cache.get('hero', 'default')?.variantId).toBe('variant-a');
  });
});
