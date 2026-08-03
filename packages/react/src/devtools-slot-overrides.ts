import type { SlotResult } from '@sentientui/core';

/**
 * Slot-override store — the channel `useSlotResult` reads (`useAdaptiveTokens` /
 * `AdaptiveGroup`). Separate from `__sentient_overrides` (variant components):
 * a slot result is a token object (`{ tone: 'urgent' }`) or an arm string
 * (`'social_first'`), never a bare variant id. Window-backed so the /devtools
 * bundle and the main bundle share one store.
 */
function store(): Record<string, SlotResult> {
  const w = window as unknown as { __sentient_slot_overrides?: Record<string, SlotResult> };
  if (!w.__sentient_slot_overrides) w.__sentient_slot_overrides = {};
  return w.__sentient_slot_overrides;
}

/** Force `slotId` to resolve to `result` — read by `useSlotResult`. */
export function setSlotOverride(slotId: string, result: SlotResult): void {
  store()[slotId] = result;
}

export function clearSlotOverride(slotId: string): void {
  delete store()[slotId];
}

export function getSlotOverrides(): Record<string, SlotResult> {
  return { ...store() };
}
