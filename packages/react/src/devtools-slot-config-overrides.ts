import type { SlotConfigEntry, StyleVocabulary } from '@sentientui/core';

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

/** Site styles for forced configs (the on-site preview of a redesigned
 *  section): the decision that would normally carry them never ran. */
export function setVocabularyOverride(v: StyleVocabulary | null): void {
  (window as unknown as { __sentient_vocabulary_override?: StyleVocabulary | null }).__sentient_vocabulary_override = v;
}

export function getVocabularyOverride(): StyleVocabulary | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __sentient_vocabulary_override?: StyleVocabulary | null }).__sentient_vocabulary_override ?? null;
}

export function clearSlotConfigOverride(slotId: string): void {
  delete store()[slotId];
}

export function getSlotConfigOverrides(): Record<string, SlotConfigEntry> {
  return { ...store() };
}
