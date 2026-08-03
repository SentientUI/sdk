declare global {
  interface Window {
    __sentient_overrides?: Record<string, string>;
  }
}

/**
 * Reads a forced variant for a component from the dev-override channels:
 * `window.__sentient_overrides[id]` (devtools panel, `applyScenario`, the
 * Playwright/Cypress helpers) or the `?sentient_variant=id:variant` URL param
 * (repeatable for multiple components). Returns `null` in non-browser envs.
 *
 * Callers MUST read this POST-MOUNT (never in the render body): it touches
 * `window.location`, which is absent on the server, so reading it during render
 * diverges the SSR output from the client's first render and throws a hydration
 * mismatch on any SSR page carrying `?sentient_variant=`.
 */
export function getDevOverride(componentId: string): string | null {
  if (typeof window === 'undefined') return null;
  const global = window.__sentient_overrides?.[componentId];
  if (global) return global;
  // This runs as a useSyncExternalStore getSnapshot (once or twice per render
  // pass, per adaptive component), so skip the URLSearchParams parse entirely on
  // the overwhelmingly common no-query-string page.
  if (!window.location.search) return null;
  try {
    const params = new URLSearchParams(window.location.search);
    for (const raw of params.getAll('sentient_variant')) {
      // sentient_variant=componentId:variantId  (repeatable for multiple components)
      const sep = raw.indexOf(':');
      if (sep === -1) continue;
      if (raw.slice(0, sep) === componentId) return raw.slice(sep + 1);
    }
  } catch {
    /* non-browser env */
  }
  return null;
}
