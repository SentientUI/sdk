import { describe, expect, it, beforeEach } from 'vitest';
import { recordEvent, getSentientEvents, clearSentientEvents, hasFiredGoal } from './events';

describe('event capture', () => {
  beforeEach(() => clearSentientEvents());

  it('records and returns events, and clears them', () => {
    recordEvent({ eventType: 'variant_assigned', componentId: 'hero', variantId: 'b' });
    expect(getSentientEvents()).toHaveLength(1);
    clearSentientEvents();
    expect(getSentientEvents()).toEqual([]);
  });

  it('hasFiredGoal matches goal_achieved and named goal events', () => {
    recordEvent({ eventType: 'goal_achieved', goalType: 'signup', componentId: 'hero' });
    recordEvent({ eventType: 'goal', goalType: 'newsletter' });
    expect(hasFiredGoal(getSentientEvents(), 'signup')).toBe(true);
    expect(hasFiredGoal(getSentientEvents(), 'newsletter')).toBe(true);
    expect(hasFiredGoal(getSentientEvents(), 'nope')).toBe(false);
  });
});
