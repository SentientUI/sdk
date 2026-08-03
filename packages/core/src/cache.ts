/** Synchronous variant assignment cache (memory + localStorage). */

export type Assignment = {
  variantId: string;
  assignedAt: number;
  segment: string;
  confidence: number;
  content?: string;
  /**
   * Per-entry expiry (ms from `assignedAt`). When present it overrides the
   * cache-wide default TTL — lets the server-provided `assignmentTtlMs` govern
   * how long this specific assignment stays valid. Persists across reloads.
   */
  ttlMs?: number;
};

export type AssignmentCache = {
  get(componentId: string, segment: string): Assignment | null;
  set(componentId: string, segment: string, assignment: Assignment): void;
  invalidate(componentId: string): void;
  clear(): void;
};

const KEY_PREFIX = '_snt_asgn_';
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function cacheKey(componentId: string, segment: string): string {
  // URI-encode each part (same scheme as storageKey) and join with a literal
  // ':'. Since encodeURIComponent escapes ':', the separator is unambiguous —
  // otherwise a segment like `device:source` could collide two distinct
  // (componentId, segment) pairs onto the same raw `${id}:${segment}` string.
  return `${encodeURIComponent(componentId)}:${encodeURIComponent(segment)}`;
}

function storageKey(componentId: string, segment: string): string {
  // Both parts are URI-encoded and joined with a literal ':' separator. Since
  // encodeURIComponent escapes ':' (and the parts can otherwise contain '_' or
  // ':'), the separator is unambiguous and the key round-trips exactly.
  return `${KEY_PREFIX}${encodeURIComponent(componentId)}:${encodeURIComponent(segment)}`;
}

function parseStorageKey(key: string): { componentId: string; segment: string } | null {
  const suffix = key.slice(KEY_PREFIX.length);
  const sep = suffix.indexOf(':');
  if (sep < 0) return null;
  try {
    return {
      componentId: decodeURIComponent(suffix.slice(0, sep)),
      segment: decodeURIComponent(suffix.slice(sep + 1)),
    };
  } catch {
    return null;
  }
}

function listStorageKeys(): string[] {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(KEY_PREFIX)) {
        keys.push(key);
      }
    }
    return keys;
  } catch {
    return [];
  }
}

/**
 * Creates an assignment cache with optional TTL (default 30 minutes).
 */
export function createAssignmentCache(ttlMs: number = DEFAULT_TTL_MS): AssignmentCache {
  const memory = new Map<string, Assignment>();

  // Honor a per-entry TTL (server-provided assignmentTtlMs) when present; fall
  // back to the cache-wide default otherwise.
  const isExpired = (assignment: Assignment): boolean =>
    assignment.assignedAt + (assignment.ttlMs && assignment.ttlMs > 0 ? assignment.ttlMs : ttlMs) < Date.now();

  const restoreFromStorage = (): void => {
    for (const key of listStorageKeys()) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const assignment = JSON.parse(raw) as Assignment;
        if (isExpired(assignment)) {
          localStorage.removeItem(key);
          continue;
        }
        const parsed = parseStorageKey(key);
        if (!parsed) continue;
        memory.set(cacheKey(parsed.componentId, parsed.segment), assignment);
      } catch {
        /* ignore corrupt entries */
      }
    }
  };

  if (typeof window !== 'undefined') {
    restoreFromStorage();
  }

  return {
    get(componentId: string, segment: string): Assignment | null {
      const entry = memory.get(cacheKey(componentId, segment));
      if (!entry) return null;
      if (isExpired(entry)) {
        memory.delete(cacheKey(componentId, segment));
        return null;
      }
      return entry;
    },

    set(componentId: string, segment: string, assignment: Assignment): void {
      const key = cacheKey(componentId, segment);
      memory.set(key, assignment);
      try {
        localStorage.setItem(storageKey(componentId, segment), JSON.stringify(assignment));
      } catch {
        /* ignore */
      }
    },

    invalidate(componentId: string): void {
      // Memory keys are encodeURIComponent(componentId) + ':' + encoded segment,
      // so match on the encoded-id prefix (the ':' after it can't appear inside
      // the encoded id).
      const prefix = `${encodeURIComponent(componentId)}:`;
      for (const key of [...memory.keys()]) {
        if (key.startsWith(prefix)) {
          memory.delete(key);
        }
      }
      for (const storageK of listStorageKeys()) {
        const parsed = parseStorageKey(storageK);
        if (parsed?.componentId === componentId) {
          try {
            localStorage.removeItem(storageK);
          } catch {
            /* ignore */
          }
        }
      }
    },

    clear(): void {
      memory.clear();
      for (const storageK of listStorageKeys()) {
        try {
          localStorage.removeItem(storageK);
        } catch {
          /* ignore */
        }
      }
    },
  };
}
