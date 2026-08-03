/**
 * Cross-bundle re-render bus for devtools overrides. The main entry and the
 * /devtools entry are separate bundles, so state and notifications go through
 * window (a version counter + a DOM event) — never module-local state.
 */
const EVENT = 'sentient:overrides-changed';

type VersionWindow = Window & { __sentient_overrides_version?: number };

export function getOverridesVersion(): number {
  if (typeof window === 'undefined') return 0;
  return (window as VersionWindow).__sentient_overrides_version ?? 0;
}

export function notifyOverridesChanged(): void {
  if (typeof window === 'undefined') return;
  const w = window as VersionWindow;
  w.__sentient_overrides_version = (w.__sentient_overrides_version ?? 0) + 1;
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeOverridesChanged(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
