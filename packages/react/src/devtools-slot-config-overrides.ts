import type { SlotConfigEntry } from '@sentientui/core';

/**
 * Slot-CONFIG override store — the channel `useSlotConfig` reads (AdaptiveSlot).
 * Separate from `__sentient_slot_overrides` (which forces the slot RESULT — the
 * arm): forcing an arm alone can't test AdaptiveSlot's rendering, because the
 * content/blocks live in the config entry. Window-backed so the /devtools and
 * /testing bundles and the main bundle share one store.
 */
function store(): Record<string, SlotConfigEntry> {
  const w = window as unknown as { __sentient_slot_config_overrides?: Record<string, SlotConfigEntry> };
  if (!w.__sentient_slot_config_overrides) w.__sentient_slot_config_overrides = {};
  return w.__sentient_slot_config_overrides;
}

/** Force `slotId`'s config entry — read by `useSlotConfig`. */
export function setSlotConfigOverride(slotId: string, entry: SlotConfigEntry): void {
  store()[slotId] = entry;
}

export function clearSlotConfigOverride(slotId: string): void {
  delete store()[slotId];
}

export function getSlotConfigOverrides(): Record<string, SlotConfigEntry> {
  return { ...store() };
}
