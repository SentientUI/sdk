import { describe, it, expect } from 'vitest';
import { TOPICS, parentOfTopic, roleOfTopic, SEMANTIC_PARENTS } from './taxonomy';

describe('taxonomy', () => {
  it('maps every topic to a valid parent', () => {
    for (const t of TOPICS) {
      expect(SEMANTIC_PARENTS).toContain(t.parent);
    }
  });

  it('has no duplicate topic keys', () => {
    const keys = TOPICS.map((t) => t.topic);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('projects a topic to its parent', () => {
    expect(parentOfTopic('services')).toBe('features');
    expect(parentOfTopic('insurance')).toBe('trust');
    expect(parentOfTopic('reviews')).toBe('social_proof');
  });

  it('falls back to generic for an unknown topic', () => {
    // Unknown topics must never crash a join or hijack an ordering slot.
    expect(parentOfTopic('lease_returns_2')).toBe('generic');
  });

  it('marks nav and footer structural, and booking a converter', () => {
    expect(roleOfTopic('navigation')).toBe('structural');
    expect(roleOfTopic('footer')).toBe('structural');
    expect(roleOfTopic('booking')).toBe('converter');
  });

  it('defaults an unknown topic to persuader, never structural', () => {
    // Structural sections are PINNED and never reordered. Defaulting an unknown
    // topic to structural would silently freeze real content in place.
    expect(roleOfTopic('whatever')).toBe('persuader');
  });

  it('keeps every parent reachable from at least one topic', () => {
    const parents = new Set(TOPICS.map((t) => t.parent));
    for (const p of SEMANTIC_PARENTS) expect(parents).toContain(p);
  });
});
