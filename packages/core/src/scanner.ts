/** Reads the rendered DOM to build the page-side context graph. */

import { classifySection, SEMANTIC_TYPES, type SemanticType } from './engagement/classify';

export type ScannedNode = {
  componentId: string;
  semanticType: string;
  ariaLabel?: string;
  headingText?: string;
  isAboveFold: boolean;
  prominenceScore: number;
  depth: number;
  reactComponentName?: string;
  dataAttributes: Record<string, string>;
};

export type StructuralEdge = {
  fromComponentId: string;
  toComponentId: string;
  /** 0.6 for direct parent → child, 0.3 for sibling (both directions emitted). */
  weight: number;
};

export type ScanResult = {
  nodes: ScannedNode[];
  edges: StructuralEdge[];
  scannedAt: number;
};

export type ContentAddedEvent = {
  nodes: ScannedNode[];
  edges: StructuralEdge[];
  addedAt: number;
};

export type DOMScanner = {
  scan(): Promise<ScanResult>;
  observe(onContentAdded: (event: ContentAddedEvent) => void): void;
  getProminenceScore(element: Element): number;
  destroy(): void;
};

const OBSERVE_TAGS = new Set(['SECTION', 'ARTICLE', 'MAIN', 'DIV']);
const HEADING_SELECTOR = 'h1, h2, h3';

// Sibling detection is O(n²) per group and emits two edges per pair, so a page
// with hundreds of co-located components (e.g. a 200-cell product grid) would
// otherwise emit tens of thousands of low-signal sibling edges. We cap the
// sibling fan-out per group and the total structural edges per detection pass.
// The total stays well under the server's 2000-edge-per-sync limit, leaving room
// for semantic edges. Parent→child edges (higher signal) are emitted first, so
// the cap sheds sibling edges before it ever touches them.
const MAX_SIBLINGS_PER_GROUP = 30;
const MAX_STRUCTURAL_EDGES = 1500;

const SSR_SCANNER: DOMScanner = {
  scan: async () => ({ nodes: [], edges: [], scannedAt: 0 }),
  observe: () => undefined,
  getProminenceScore: () => 0,
  destroy: () => undefined,
};

function normalize(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function readReactComponentName(element: Element): string | undefined {
  try {
    const record = element as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!key.startsWith('__reactFiber') && !key.startsWith('__reactInternalInstance')) {
        continue;
      }
      const fiber = record[key] as { type?: { name?: string; displayName?: string } };
      const name = fiber?.type?.displayName ?? fiber?.type?.name;
      if (name && name.length > 1) {
        return name;
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function extractDataAttributes(element: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) {
    if (attr.name.startsWith('data-')) {
      attrs[attr.name] = attr.value;
    }
  }
  return attrs;
}

const SEMANTIC_SET: ReadonlySet<string> = new Set(SEMANTIC_TYPES);

// Explicit tag wins → role → heuristic → generic. Every output is normalized to
// the graph_nodes enum: an out-of-vocabulary data-sentient-type/role falls
// through to the heuristic instead of being emitted raw (raw values violated
// the graph_nodes CHECK constraint on insert).
function inferSemanticType(element: Element): SemanticType {
  const explicit = element.getAttribute('data-sentient-type');
  if (explicit && SEMANTIC_SET.has(explicit)) return explicit as SemanticType;
  const role = element.getAttribute('role');
  if (role && SEMANTIC_SET.has(role)) return role as SemanticType;
  return classifySection(element);
}

// djb2 over a string → 8-hex-char digest. Stable and collision-resistant enough
// to disambiguate co-located components that declare no id of their own.
function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) & 0xffffffff;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// A structural path (tag + sibling index at each level up to the root) uniquely
// and stably identifies an element's DOM position, so two id-less sections don't
// hash to the same value the way a bare tagName would.
function domPathSignature(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current) {
    const parent: Element | null = current.parentElement;
    if (!parent) {
      parts.push(current.tagName.toLowerCase());
      break;
    }
    const index = Array.prototype.indexOf.call(parent.children, current);
    parts.push(`${current.tagName.toLowerCase()}[${index}]`);
    current = parent;
  }
  return parts.reverse().join('/');
}

// Prefer an author-declared id. When none exists, synthesize a stable, unique id
// from the element's DOM path — the old `tagName.toLowerCase()` fallback gave
// every id-less <section> the same "section" id, so a second such node silently
// overwrote the first in the componentId-keyed graph Map (node loss).
function componentIdFor(element: Element): string {
  const declared =
    element.getAttribute('data-sentient-id') ?? element.getAttribute('id');
  if (declared) return declared;
  return `${element.tagName.toLowerCase()}-${shortHash(domPathSignature(element))}`;
}

function depthOf(element: Element): number {
  let depth = 0;
  let current: Element | null = element.parentElement;
  while (current) {
    depth++;
    current = current.parentElement;
  }
  return depth;
}

function scanElement(
  element: Element,
  getProminenceScore: (el: Element) => number,
): ScannedNode {
  const heading = element.querySelector(HEADING_SELECTOR);
  return {
    componentId: componentIdFor(element),
    semanticType: inferSemanticType(element),
    ariaLabel: element.getAttribute('aria-label') ?? undefined,
    headingText: heading?.textContent?.trim() ?? undefined,
    isAboveFold: element.getBoundingClientRect().top < window.innerHeight,
    prominenceScore: getProminenceScore(element),
    depth: depthOf(element),
    reactComponentName: readReactComponentName(element),
    dataAttributes: extractDataAttributes(element),
  };
}

/**
 * Detects structural relationships between scanned component elements:
 *  - parent → child (direct ancestor link, weight 0.6)
 *  - sibling ↔ sibling (share nearest component ancestor, weight 0.3, bidirectional)
 * A pair appears at most once per direction.
 */
function detectStructuralEdges(elementToId: Map<Element, string>): StructuralEdge[] {
  const edges: StructuralEdge[] = [];
  const seen = new Set<string>();
  const ROOT = '__root__';

  // Parent → child: nearest component ancestor only.
  const groups = new Map<string, Element[]>();
  for (const [el, _id] of elementToId) {
    let ancestor: Element | null = el.parentElement;
    let groupKey = ROOT;
    while (ancestor) {
      if (elementToId.has(ancestor)) {
        groupKey = elementToId.get(ancestor)!;
        const childId = elementToId.get(el)!;
        const key = `${groupKey}->${childId}`;
        if (!seen.has(key) && groupKey !== childId) {
          seen.add(key);
          edges.push({ fromComponentId: groupKey, toComponentId: childId, weight: 0.6 });
        }
        break;
      }
      ancestor = ancestor.parentElement;
    }
    const siblings = groups.get(groupKey) ?? [];
    siblings.push(el);
    groups.set(groupKey, siblings);
  }

  // Sibling ↔ sibling: same ancestor group.
  for (const sibs of groups.values()) {
    if (sibs.length < 2) continue;
    // Cap the fan-out of any single group before the O(n²) pairing.
    const capped = sibs.length > MAX_SIBLINGS_PER_GROUP ? sibs.slice(0, MAX_SIBLINGS_PER_GROUP) : sibs;
    for (let i = 0; i < capped.length; i++) {
      for (let j = i + 1; j < capped.length; j++) {
        if (edges.length >= MAX_STRUCTURAL_EDGES) return edges;
        const aId = elementToId.get(capped[i]!)!;
        const bId = elementToId.get(capped[j]!)!;
        if (aId === bId) continue;
        const fwd = `${aId}->${bId}::sib`;
        const rev = `${bId}->${aId}::sib`;
        if (!seen.has(fwd)) {
          seen.add(fwd);
          edges.push({ fromComponentId: aId, toComponentId: bId, weight: 0.3 });
        }
        if (!seen.has(rev)) {
          seen.add(rev);
          edges.push({ fromComponentId: bId, toComponentId: aId, weight: 0.3 });
        }
      }
    }
  }

  return edges;
}

function collectNodesAndEdges(
  getProminenceScore: (el: Element) => number,
): { nodes: ScannedNode[]; edges: StructuralEdge[]; elementToId: Map<Element, string> } {
  const nodes: ScannedNode[] = [];
  const seen = new Set<Element>();
  const elementToId = new Map<Element, string>();

  const registered = document.querySelectorAll('[data-sentient-id]');
  registered.forEach((el) => {
    if (el instanceof Element && !seen.has(el)) {
      seen.add(el);
      const node = scanElement(el, getProminenceScore);
      nodes.push(node);
      elementToId.set(el, node.componentId);
    }
  });

  const structural = document.querySelectorAll('section, article, main, aside');
  structural.forEach((el) => {
    if (!(el instanceof Element) || seen.has(el)) return;
    const hasAria = el.hasAttribute('aria-label');
    const hasSentientId = el.hasAttribute('data-sentient-id');
    if (!hasAria && !hasSentientId) return;
    seen.add(el);
    const node = scanElement(el, getProminenceScore);
    nodes.push(node);
    elementToId.set(el, node.componentId);
  });

  return { nodes, edges: detectStructuralEdges(elementToId), elementToId };
}

/**
 * Creates a DOM scanner that uses idle callbacks and mutation observation.
 */
export function createDOMScanner(): DOMScanner {
  if (typeof window === 'undefined') {
    return SSR_SCANNER;
  }

  let observer: MutationObserver | null = null;
  let idleCallbackId = 0;
  let contentCallback: ((event: ContentAddedEvent) => void) | null = null;
  // Element→componentId for every node registered so far (initial scan + prior
  // mutations). The MutationObserver detects edges against this whole set — not
  // just the nodes in the current mutation — so a child inserted under an
  // already-scanned parent still gets its parent→child edge.
  const knownElementToId = new Map<Element, string>();

  const getProminenceScore = (element: Element): number => {
    try {
      const styles = window.getComputedStyle(element);
      const fontSize = parseFloat(styles.fontSize) || 12;
      const zIndex = parseFloat(styles.zIndex) || 0;
      const rect = element.getBoundingClientRect();
      const distanceFromTop = Math.max(rect.top, 0);
      const viewportHeight = window.innerHeight || 1;
      const inverseDistance = 1 / (distanceFromTop / viewportHeight + 1);

      // inverseDistance is already in (0, 1] by construction, so it needs no
      // further normalization — only fontSize and zIndex are rescaled.
      const score =
        normalize(fontSize, 12, 48) * 0.4 +
        inverseDistance * 0.4 +
        normalize(zIndex, 0, 100) * 0.2;

      return Math.max(0, Math.min(1, score));
    } catch {
      return 0.5;
    }
  };

  const scan = (): Promise<ScanResult> =>
    new Promise((resolve) => {
      const run = (): void => {
        const { nodes, edges, elementToId } = collectNodesAndEdges(getProminenceScore);
        // Seed the known-element registry so the observer can resolve parents that
        // were registered in this scan when later children are inserted.
        knownElementToId.clear();
        for (const [el, id] of elementToId) knownElementToId.set(el, id);
        resolve({ nodes, edges, scannedAt: Date.now() });
      };

      try {
        if (typeof requestIdleCallback === 'function') {
          idleCallbackId = requestIdleCallback(run, { timeout: 100 });
        } else {
          run();
        }
      } catch {
        run();
      }
    });

  const observe = (onContentAdded: (event: ContentAddedEvent) => void): void => {
    contentCallback = onContentAdded;
    try {
      observer = new MutationObserver((mutations) => {
        const added: ScannedNode[] = [];
        const addedIds = new Set<string>();
        for (const mutation of mutations) {
          if (mutation.type !== 'childList') continue;
          mutation.addedNodes.forEach((node) => {
            if (!(node instanceof Element)) return;
            if (!OBSERVE_TAGS.has(node.tagName)) return;
            const hasId = node.hasAttribute('data-sentient-id');
            const hasAria = node.hasAttribute('aria-label');
            if (!hasId && !hasAria) return;
            const scanned = scanElement(node, getProminenceScore);
            added.push(scanned);
            addedIds.add(scanned.componentId);
            knownElementToId.set(node, scanned.componentId);
          });
        }
        if (added.length === 0 || !contentCallback) return;
        // Drop elements no longer in the document so removed nodes don't dangle
        // and the map stays bounded.
        for (const el of [...knownElementToId.keys()]) {
          if (!el.isConnected) knownElementToId.delete(el);
        }
        // Detect over the FULL known set so a child inserted under an already-
        // scanned parent still gets its parent→child edge, then surface only the
        // edges that touch a newly-added node (existing edges were already emitted).
        const edges = detectStructuralEdges(knownElementToId).filter(
          (e) => addedIds.has(e.fromComponentId) || addedIds.has(e.toComponentId),
        );
        contentCallback({ nodes: added, edges, addedAt: Date.now() });
      });
      observer.observe(document.body, { childList: true, subtree: true });
    } catch {
      /* ignore */
    }
  };

  const destroy = (): void => {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (idleCallbackId && typeof cancelIdleCallback === 'function') {
      try {
        cancelIdleCallback(idleCallbackId);
      } catch {
        /* ignore */
      }
    }
    idleCallbackId = 0;
    contentCallback = null;
    knownElementToId.clear();
  };

  return {
    scan,
    observe,
    getProminenceScore,
    destroy,
  };
}
