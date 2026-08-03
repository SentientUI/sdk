/** Per-component weights store with isolated subscriptions. */

export type VariantWeight = {
  variantId: string;
  pulls: number;
  avgReward: number;
};

export type ComponentWeights = {
  componentId: string;
  variants: VariantWeight[];
  updatedAt: number;
};

type Listener = (weights: ComponentWeights) => void;

const store = new Map<string, ComponentWeights>();
const listeners = new Map<string, Set<Listener>>();

/**
 * Subscribes a listener to a single component. Returns an unsubscribe function.
 * Updates to other components never trigger this listener.
 */
export function subscribe(componentId: string, cb: Listener): () => void {
  let set = listeners.get(componentId);
  if (!set) {
    set = new Set();
    listeners.set(componentId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(componentId);
  };
}

/**
 * Replaces the weights for a component and notifies only that component's
 * subscribers.
 */
export function update(componentId: string, weights: ComponentWeights): void {
  store.set(componentId, weights);
  const set = listeners.get(componentId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(weights);
    } catch {
      /* never throw to other listeners */
    }
  }
}

/**
 * Returns the latest known weights for a component, or null if none seen.
 */
export function getWeights(componentId: string): ComponentWeights | null {
  return store.get(componentId) ?? null;
}

/** Test-only: wipe the entire store. */
export function _resetWeightsStore(): void {
  store.clear();
  listeners.clear();
}
