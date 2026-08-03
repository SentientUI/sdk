/** Manages anonymous session identity with cookie + localStorage layers. */

import { randomUuidV4 } from './uuid.js';
import { storageSuffix } from './storage-key.js';

export type SessionConfig = {
  cookieName?: string;
  cookieTTLDays?: number;
  /**
   * Public apiKey — namespaces the `_snt_uid` cookie + storage per project, so
   * two projects on the same exact origin don't share a visitor id (which would
   * cross-contaminate sessions server-side). Omit in local mode.
   */
  apiKey?: string;
  /**
   * Session ID generated during SSR (e.g. from `loadAdaptiveAssignments`).
   * Used as the fallback when no existing cookie or localStorage entry is found,
   * so the client adopts the same session the server used for variant assignment
   * on first visit rather than generating a new, orphaned ID.
   */
  ssrSessionId?: string;
};

export type SessionManager = {
  getSessionId(): string | null;
  /** True when neither cookie nor localStorage could be written — id is in-memory only. */
  isEphemeral(): boolean;
  destroy(): void;
};

const DEFAULT_COOKIE_NAME = '_snt_uid';
const DEFAULT_COOKIE_TTL_DAYS = 365;
const STORAGE_KEY = '_snt_uid';

/**
 * Generates a unique session identifier. Always an RFC 4122 v4 UUID — the id is
 * stored server-side in a Postgres `uuid` column, so the insecure-context
 * fallback must not emit a malformed value (see `randomUuidV4`).
 */
function generateSessionId(): string {
  return randomUuidV4();
}

function readCookie(name: string): string | null {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function writeCookie(name: string, value: string, maxAgeSeconds: number): void {
  try {
    document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAgeSeconds}; SameSite=strict; path=/`;
  } catch {
    /* ignore */
  }
}

function readLocalStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function readSessionStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionStorage(key: string, value: string): boolean {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeSessionStorage(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function probeCookieWritable(name: string): boolean {
  try {
    document.cookie = `${name}_probe=1; max-age=1; SameSite=strict; path=/`;
    return document.cookie.indexOf(`${name}_probe=1`) !== -1;
  } catch {
    return false;
  }
}

function removeLocalStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function clearCookie(name: string): void {
  try {
    document.cookie = `${name}=; max-age=0; SameSite=strict; path=/`;
  } catch {
    /* ignore */
  }
}

const SSR_MANAGER: SessionManager = {
  getSessionId: () => null,
  isEphemeral: () => false,
  destroy: () => undefined,
};

/**
 * Initializes session management. Returns a no-op manager in SSR environments.
 */
export function initSession(config?: SessionConfig): SessionManager {
  if (typeof window === 'undefined') {
    return SSR_MANAGER;
  }

  // Namespace the visitor-id keys per project so multiple keys on one origin
  // don't share a `_snt_uid` (see storage-key.ts). An explicit cookieName still
  // wins for callers that manage their own naming.
  const suffix = storageSuffix(config?.apiKey);
  const cookieName = config?.cookieName ?? `${DEFAULT_COOKIE_NAME}${suffix}`;
  const storageKey = `${STORAGE_KEY}${suffix}`;
  const cookieTTLDays = config?.cookieTTLDays ?? DEFAULT_COOKIE_TTL_DAYS;
  const maxAgeSeconds = cookieTTLDays * 24 * 60 * 60;

  // Treat an empty string from any layer as absent. A `_snt_uid=` cookie with no
  // value (or an empty localStorage/sessionStorage entry) decodes to '', which is
  // not nullish — a plain `??` chain would keep it and persist it for a year,
  // leaving getSessionId() falsy so every track/goal/upsert bails out and the
  // visitor is permanently muted with no way to regenerate. Coercing '' to null
  // lets the chain fall through to a real id (or a freshly generated one).
  const nonEmpty = (value: string | null | undefined): string | null =>
    value && value.length > 0 ? value : null;

  let sessionId: string | null =
    nonEmpty(readCookie(cookieName)) ??
    nonEmpty(readLocalStorage(storageKey)) ??
    nonEmpty(readSessionStorage(storageKey)) ??
    nonEmpty(config?.ssrSessionId) ??
    generateSessionId();

  writeCookie(cookieName, sessionId, maxAgeSeconds);
  const lsOk = writeLocalStorage(storageKey, sessionId);
  const cookieOk = probeCookieWritable(cookieName);
  // Always write sessionStorage when localStorage fails — it covers same-tab
  // navigation even in strict storage environments.
  const ssOk = !lsOk ? writeSessionStorage(storageKey, sessionId) : false;
  const ephemeral = !lsOk && !cookieOk && !ssOk;

  return {
    getSessionId: () => sessionId,
    isEphemeral: () => ephemeral,
    destroy: () => {
      sessionId = null;
      clearCookie(cookieName);
      removeLocalStorage(storageKey);
      removeSessionStorage(storageKey);
    },
  };
}
