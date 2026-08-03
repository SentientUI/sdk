/** In-memory context graph with persistence and backend sync. */

import { storageSuffix } from './storage-key.js';

export type PageNode = {
  id: string;
  componentId: string;
  semanticType: string;
  answers: string[];
  prominenceScore: number;
  depth: number;
};

export type GraphSnapshot = {
  pageNodes: PageNode[];
  capturedAt: number;
};

export type GraphConfig = {
  syncUrl?: string;
  apiKey?: string;
  projectId?: string;
  sessionId?: string;
};

export type StructuralEdge = {
  fromComponentId: string;
  toComponentId: string;
  weight: number;
};

export type GraphClient = {
  addPageNode(node: PageNode): void;
  /** Record a DOM-derived parent/child or sibling relationship between two components. */
  addStructuralEdge(edge: StructuralEdge): void;
  /** One-shot batch sync of all current page nodes to the backend. */
  syncOnce(): void;
  snapshot(): GraphSnapshot;
  serialize(): string;
  restore(data: string): void;
  destroy(): void;
};

// _snt_graph_edges was written by earlier builds but never synced to the backend.
// We still read and clear any leftover key on init/destroy so old clients don't
// accumulate stale data, but we no longer write it.
const STALE_EDGES_KEY = '_snt_graph_edges';

const SEMANTIC_NEIGHBOURS: Record<string, string[]> = {
  pricing: ['features', 'faq'],
  features: ['pricing'],
  faq: ['pricing'],
  social_proof: ['cta'],
  cta: ['social_proof', 'hero', 'trust'],
  hero: ['cta'],
  comparison: ['pricing'],
  trust: ['cta'],
};

function neighboursFor(semanticType: string): string[] {
  return SEMANTIC_NEIGHBOURS[semanticType] ?? [];
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

const VALID_SEMANTIC_TYPES = new Set([
  'pricing', 'hero', 'social_proof', 'cta', 'features',
  'faq', 'comparison', 'trust', 'navigation', 'generic',
]);

function toValidSemanticType(type: string): string {
  return VALID_SEMANTIC_TYPES.has(type) ? type : 'generic';
}

/**
 * Path-only page URL for graph sync — strips query + fragment so tokens,
 * emails, and other sensitive URL params never leave the browser by default.
 */
export function sanitizePageUrl(href: string): string {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '/';
  }
}

function contentHashOf(componentId: string, semanticType: string, answers: string[]): string {
  const input = `${componentId}:${semanticType}:${answers.join(',')}`;
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) & 0xffffffff;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Creates an in-memory graph client with optional persistence and sync.
 */
export function createGraphClient(config?: GraphConfig): GraphClient {
  const pageNodes = new Map<string, PageNode>();
  const structuralEdges = new Map<string, StructuralEdge>();

  // Per-project localStorage key so two projects on one origin don't share a
  // graph-node cache (see storage-key.ts). Legacy `_snt_graph_nodes` with no key.
  const nodesKey = `_snt_graph_nodes${storageSuffix(config?.apiKey)}`;

  const persist = (): void => {
    if (typeof window === 'undefined') return;
    writeStorage(nodesKey, [...pageNodes.values()]);
  };

  const restore = (data: string): void => {
    try {
      const parsed = JSON.parse(data) as { pageNodes?: PageNode[] };
      pageNodes.clear();
      for (const node of parsed.pageNodes ?? []) {
        pageNodes.set(node.componentId, node);
      }
    } catch {
      /* ignore corrupt state */
    }
  };

  if (typeof window !== 'undefined') {
    const storedNodes = readStorage<PageNode[]>(nodesKey, []);
    for (const node of storedNodes) {
      pageNodes.set(node.componentId, node);
    }
    // Clear any stale edge data written by older SDK versions.
    try { localStorage.removeItem(STALE_EDGES_KEY); } catch { /* ignore */ }
  }

  return {
    addPageNode(node: PageNode): void {
      pageNodes.set(node.componentId, node);
      persist();
    },

    addStructuralEdge(edge: StructuralEdge): void {
      const key = `${edge.fromComponentId}->${edge.toComponentId}`;
      structuralEdges.set(key, edge);
    },

    syncOnce(): void {
      if (!config?.syncUrl || typeof window === 'undefined') return;
      const nodes = [...pageNodes.values()];
      if (nodes.length === 0) return;
      try {
        // Build semantic edges from the SEMANTIC_NEIGHBOURS map. Each node emits
        // an edge to every present sibling that matches one of its neighbour types.
        // Weight matches propagate()'s 0.4 attention factor; confidence is high
        // because the mapping is curated, not inferred.
        const nodesByType = new Map<string, PageNode[]>();
        for (const n of nodes) {
          const list = nodesByType.get(n.semanticType) ?? [];
          list.push(n);
          nodesByType.set(n.semanticType, list);
        }
        const edges: Array<{
          fromComponentId: string;
          toComponentId: string;
          type: 'semantic' | 'structural';
          weight: number;
          confidence: number;
        }> = [];
        const seen = new Set<string>();
        for (const source of nodes) {
          for (const neighbourType of neighboursFor(source.semanticType)) {
            const targets = nodesByType.get(neighbourType) ?? [];
            for (const target of targets) {
              if (target.componentId === source.componentId) continue;
              const key = `semantic:${source.componentId}->${target.componentId}`;
              if (seen.has(key)) continue;
              seen.add(key);
              edges.push({
                fromComponentId: source.componentId,
                toComponentId: target.componentId,
                type: 'semantic',
                weight: 0.4,
                confidence: 0.9,
              });
            }
          }
        }

        // Structural edges from DOM relationships, recorded during scan.
        // Only emit when both endpoints are present in this page's node set —
        // a structural edge to/from a node that no longer exists would dangle.
        const componentIds = new Set(nodes.map((n) => n.componentId));
        for (const edge of structuralEdges.values()) {
          if (!componentIds.has(edge.fromComponentId) || !componentIds.has(edge.toComponentId)) continue;
          const key = `structural:${edge.fromComponentId}->${edge.toComponentId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            fromComponentId: edge.fromComponentId,
            toComponentId: edge.toComponentId,
            type: 'structural',
            weight: edge.weight,
            confidence: 1.0,
          });
        }

        const payload = {
          pageUrl: sanitizePageUrl(window.location.href),
          // Visitor/project attribution. The /graph/sync handler ignores unknown
          // top-level fields (Fastify additionalProperties + Zod strips extras),
          // so these ride along harmlessly and let beacons carry attribution.
          ...(config.sessionId ? { sessionId: config.sessionId } : {}),
          ...(config.projectId ? { projectId: config.projectId } : {}),
          nodes: nodes.map((n) => {
            const semanticType = toValidSemanticType(n.semanticType);
            return {
              componentId: n.componentId,
              semanticType,
              answers: n.answers,
              contentHash: contentHashOf(n.componentId, semanticType, n.answers),
              prominenceScore: n.prominenceScore,
              depthInPage: n.depth,
            };
          }),
          edges,
        };
        fetch(config.syncUrl, {
          method: 'POST',
          keepalive: true,
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify(payload),
        }).catch(() => undefined);
      } catch {
        /* ignore */
      }
    },

    snapshot(): GraphSnapshot {
      return {
        pageNodes: [...pageNodes.values()],
        capturedAt: Date.now(),
      };
    },

    serialize(): string {
      return JSON.stringify({ pageNodes: [...pageNodes.values()] });
    },

    restore,

    destroy(): void {
      if (typeof window === 'undefined') return;
      try {
        localStorage.removeItem(nodesKey);
        localStorage.removeItem(STALE_EDGES_KEY);
      } catch {
        /* ignore */
      }
    },
  };
}
