/**
 * Decision snapshot: the SPA / return-visit pre-paint source. Written after
 * every successful decide; read by the inline pre-paint script (before any
 * framework code runs) and by init() to seed slot/persona state.
 */
import type { SlotResult } from './slots.js';

export const SNAPSHOT_STORAGE_KEY_PREFIX = '_snt_snap:';

/** Versioned compound locator: resolve id → dataAttr → selector, then verify
 *  against fingerprint. Lets a slot survive DOM/markup drift. */
export type CompoundLocator = {
  v?: number;
  id?: string;
  dataAttr?: { name: string; value: string };
  selector?: string;
  urlMatch?: string;
  fingerprint?: { tag?: string; text?: string };
  semanticId?: string;
};

/** Bounded, declarative operations a registry arm may apply to its element.
 *  The style set is a fixed whitelist (validated server-side); no arbitrary CSS,
 *  HTML, or JS ever. `text` is applied via textContent; https-only URLs.
 *  moveBefore/moveAfter (exactly one) reposition the element relative to a
 *  uniquely-resolving sibling anchor — post-decide only, never pre-paint. */
export type SlotOps = {
  text?: string;
  style?: Record<string, string>;
  hidden?: boolean;
  href?: string;
  imageSrc?: string;
  imageAlt?: string;
  moveBefore?: CompoundLocator;
  moveAfter?: CompoundLocator;
};

/** Registry-mode apply info per slot: where to apply and what to set. Stored so
 *  a returning visitor's pre-paint can reapply it. `target` is the Phase-2 bare
 *  selector; `locator` (Phase 3) is the compound locator, preferred when present. */
export type SlotConfigEntry = {
  kind: 'tokens' | 'arms';
  target?: string;
  locator?: CompoundLocator;
  content?: string;
  ops?: SlotOps;
};

export type DecisionSnapshot = {
  v: 1;
  persona: string;
  band: 'low' | 'medium' | 'high';
  slots: Record<string, SlotResult>;
  layoutOrder: string[] | null;
  savedAt: number;
  // Additive (kept at v:1 so existing snapshots stay valid — bumping the version
  // would flush every returning visitor's snapshot and flash the baseline once).
  // Present only for registry-mode (no-code) installs.
  slotConfig?: Record<string, SlotConfigEntry>;
};

const BANDS = ['low', 'medium', 'high'];

/** Returns null on missing, corrupt, or wrong-version data — never throws. */
export function readSnapshot(apiKey: string): DecisionSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY_PREFIX + apiKey);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<DecisionSnapshot> | null;
    if (
      !p ||
      typeof p !== 'object' ||
      p.v !== 1 ||
      typeof p.persona !== 'string' ||
      typeof p.band !== 'string' ||
      !BANDS.includes(p.band) ||
      typeof p.slots !== 'object' ||
      p.slots === null ||
      Array.isArray(p.slots) ||
      !(p.layoutOrder === null || Array.isArray(p.layoutOrder)) ||
      typeof p.savedAt !== 'number' ||
      // slotConfig is optional; when present it must be a plain object.
      !(p.slotConfig === undefined || (typeof p.slotConfig === 'object' && p.slotConfig !== null && !Array.isArray(p.slotConfig)))
    ) {
      return null;
    }
    return p as DecisionSnapshot;
  } catch {
    return null;
  }
}

/** Best-effort persist — storage failures are swallowed. */
export function writeSnapshot(apiKey: string, snap: DecisionSnapshot): void {
  try {
    localStorage.setItem(SNAPSHOT_STORAGE_KEY_PREFIX + apiKey, JSON.stringify(snap));
  } catch {
    /* private mode / quota — the snapshot is an optimization, never a requirement */
  }
}

/**
 * Inline pre-paint script (Rung 1a): reads the snapshot and sets
 * `data-sentient-persona` / `data-sentient-confidence` on <html> before
 * first paint. Single-writer: it never overwrites attributes already set.
 *
 * Safety properties (pinned by tests):
 * - apiKey goes through JSON.stringify, then '<' is escaped to <, so a
 *   hostile key can neither break the JS string nor terminate the <script>.
 * - Built by string concatenation and contains no backticks, so the output
 *   survives being embedded in template-literal-based renderers.
 */
export function renderPrePaintScript(apiKey: string): string {
  const key = JSON.stringify(SNAPSHOT_STORAGE_KEY_PREFIX + apiKey).replace(/</g, '\\u003c');
  return (
    '(function(){try{' +
    'var r=localStorage.getItem(' + key + ');if(!r)return;' +
    'var s=JSON.parse(r);' +
    'if(!s||s.v!==1||typeof s.persona!=="string"||typeof s.band!=="string")return;' +
    'var d=document.documentElement;' +
    'if(d.hasAttribute("data-sentient-persona"))return;' +
    'd.setAttribute("data-sentient-persona",s.persona);' +
    'd.setAttribute("data-sentient-confidence",s.band);' +
    '}catch(e){}})();'
  );
}
