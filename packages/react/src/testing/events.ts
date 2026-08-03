export type CapturedEvent = {
  eventType: string;
  goalType?: string;
  componentId?: string;
  variantId?: string;
  [k: string]: unknown;
};

const captured: CapturedEvent[] = [];

export function recordEvent(e: CapturedEvent): void {
  captured.push(e);
}

export function getSentientEvents(): CapturedEvent[] {
  return [...captured];
}

export function clearSentientEvents(): void {
  captured.length = 0;
}

/** True if any captured event is a goal (component goal_achieved or named goal) with this name. */
export function hasFiredGoal(events: CapturedEvent[], goalName: string): boolean {
  return events.some(
    (e) => (e.eventType === 'goal_achieved' || e.eventType === 'goal') && e.goalType === goalName,
  );
}
