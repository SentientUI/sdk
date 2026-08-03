function store(): Record<string, string> {
  const w = window as unknown as { __sentient_overrides?: Record<string, string> };
  if (!w.__sentient_overrides) w.__sentient_overrides = {};
  return w.__sentient_overrides;
}

/** Force `componentId` to render `variantId` — read by `useAssignment`. */
export function setVariantOverride(componentId: string, variantId: string): void {
  store()[componentId] = variantId;
}

export function clearVariantOverride(componentId: string): void {
  delete store()[componentId];
}

export function getOverrides(): Record<string, string> {
  return { ...store() };
}
