import { isDevBuild } from './adaptive-shared.js';

export type RegisteredComponent = { id: string; variantIds: string[]; goal?: string };
export type RegisteredSlot = {
  id: string;
  arms?: string[];
  dims?: Record<string, readonly string[]>;
};

type RegistryState = {
  components: Map<string, RegisteredComponent>;
  slots: Map<string, RegisteredSlot>;
  sections: string[];
  listeners: Set<() => void>;
  /** Bumped on every mutation so `useSyncExternalStore` can read a stable, comparable snapshot. */
  version: number;
};

// Shared through a window global: the main entry and the /devtools entry are
// separate bundles, each with its own copy of this module — module-local
// state would give the devtools an always-empty registry in published apps.
const ssrFallback: RegistryState = {
  components: new Map(),
  slots: new Map(),
  sections: [],
  listeners: new Set(),
  version: 0,
};

function state(): RegistryState {
  if (typeof window === 'undefined') return ssrFallback;
  const w = window as unknown as { __sentient_registry?: RegistryState };
  if (!w.__sentient_registry) {
    w.__sentient_registry = {
      components: new Map(),
      slots: new Map(),
      sections: [],
      listeners: new Set(),
      version: 0,
    };
  }
  return w.__sentient_registry;
}

function emit(): void {
  // Bump BEFORE notifying so a useSyncExternalStore consumer re-reading its
  // snapshot inside the notification sees the new value and re-renders.
  state().version += 1;
  for (const fn of state().listeners) fn();
}

// The registry exists solely to feed the opt-in devtools panel, which is a
// dev-only surface. In a production build there is no panel reading it, so
// every register call is dead work plus a `window.__sentient_registry`
// footprint on the customer's page. Short-circuit to a noop in production —
// every <Adaptive>/useAdaptive/slot mount calls one of these.
const NOOP_UNREGISTER = (): void => undefined;

/** Register (or re-register) a component. Returns an unregister function. */
export function registerComponent(c: RegisteredComponent): () => void {
  if (!isDevBuild()) return NOOP_UNREGISTER;
  state().components.set(c.id, c);
  emit();
  return () => {
    state().components.delete(c.id);
    emit();
  };
}

/** Register (or re-register) a slot declaration. Returns an unregister function. */
export function registerSlot(s: RegisteredSlot): () => void {
  if (!isDevBuild()) return NOOP_UNREGISTER;
  state().slots.set(s.id, s);
  emit();
  return () => {
    state().slots.delete(s.id);
    emit();
  };
}

/** Register the page's declared section ids (from AdaptiveRoot/provider). */
export function registerSections(sections: string[]): void {
  if (!isDevBuild()) return;
  state().sections = [...sections];
  emit();
}

export function getRegistered(): RegisteredComponent[] {
  return [...state().components.values()];
}

export function getRegisteredSlots(): RegisteredSlot[] {
  return [...state().slots.values()];
}

export function getRegisteredSections(): string[] {
  return [...state().sections];
}

export function subscribeRegistry(fn: () => void): () => void {
  const listeners = state().listeners;
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Monotonic snapshot for `useSyncExternalStore` — changes on every registry mutation. */
export function getRegistryVersion(): number {
  return state().version;
}
