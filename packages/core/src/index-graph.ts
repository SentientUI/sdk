/**
 * Graph-capable entry point for @sentientui/core.
 *
 * Import from `@sentientui/core/graph` when you need DOM graph scanning and
 * page-structure sync. This entry pulls in `scanner.ts` and `graph.ts` at
 * build time, giving bundlers a real tree-shaking boundary. Standard A/B tests
 * should use `@sentientui/core` (the lean entry) instead.
 */

// Re-export everything from the lean entry except `init`, which we override below.
export {
  detectDeviceClass,
  detectTrafficSource,
  detectTimeOfDay,
  deriveSessionSegment,
  referrerDomainFromReferer,
} from './index.js';
// SSR preload helpers moved to `@sentientui/core/server` in 0.6.0.
export type {
  SentientConfig,
  AssignResult,
  SentientClient,
} from './index.js';
export type {
  SessionConfig,
  SessionManager,
  EventType,
  SentientEvent,
  QueueConfig,
  Assignment,
} from './index.js';
// EventQueue/AssignmentCache are no longer on the lean barrel — source them from
// their own modules so the `/graph` subpath keeps exposing them unchanged.
export type { EventQueue } from './queue.js';
export type { AssignmentCache } from './cache.js';
// Scanner + graph types (live in this entry only).
export type {
  ScannedNode,
  ScanResult,
  ContentAddedEvent,
  DOMScanner,
} from './scanner.js';
export type {
  PageNode,
  GraphSnapshot,
  GraphConfig,
  GraphClient,
} from './graph.js';

import { init as initLean, isDoNotTrackEnabled, type SentientConfig, type SentientClient } from './index.js';

const DEFAULT_INGEST_URL = 'https://api.sentient-ui.com/v1/events';
import { createDOMScanner } from './scanner.js';
import { createGraphClient } from './graph.js';

export type GraphSentientConfig = SentientConfig & {
  /**
   * Enable DOM graph scanning and page-structure sync. Wires a MutationObserver
   * and a localStorage-backed graph. When `false` (default) this entry behaves
   * identically to `@sentientui/core`.
   */
  graph?: boolean;
};

function readSntUid(): string | undefined {
  try {
    const m = document.cookie.match(/(?:^|; )_snt_uid=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Graph-capable variant of `init()`. Identical to the lean `init` when
 * `config.graph` is `false` (or omitted). When `config.graph: true`, mounts
 * a DOM scanner + graph client and enables `client.getGraph()`.
 *
 * Import from `@sentientui/core/graph` — do not call the lean `init` alongside
 * this function as that would initialise two clients.
 */
// Teardown for the graph resources (scanner + MutationObserver + debounce
// timer + graph client) bound to each apiKey. initLean already disposes the
// lean client's own timers/listeners on re-init, but it knows nothing about
// these graph resources, so this entry tracks and tears them down itself —
// otherwise an HMR / consent-toggle / provider-remount re-init would leak a
// live MutationObserver and a pending sync timer per mount.
const _graphTeardowns = new Map<string, () => void>();

export function init(config: GraphSentientConfig): SentientClient {
  const client = initLean(config);

  // Mirror initLean's opt-out gate: a DNT/GPC visitor (or consent:false) must
  // not get the DOM scanner + graph sync, which POST page-structure beacons and
  // read `_snt_uid` — tracking that bypasses the lean client's own gating, even
  // under `preConsentBehavior: 'statistical_winner'` (audit P1).
  const dntBlocked = config.respectDoNotTrack !== false && isDoNotTrackEnabled();
  const gated = config.consent === false || dntBlocked;

  // Keyless zero-network contract: with no api key there is nothing to feed —
  // the scanner must never mount and /v1/graph/sync must never fire.
  if (!config.graph || !config.apiKey || gated || typeof window === 'undefined') return client;

  // A prior graph mount for this key is now superseded — tear it down first so
  // its observer/timer don't leak alongside the new mount's.
  const prevTeardown = _graphTeardowns.get(config.apiKey);
  if (prevTeardown) {
    try {
      prevTeardown();
    } catch {
      /* teardown must never throw on re-init */
    }
  }

  const domScanner = createDOMScanner();
  const resolvedIngestUrl = config.ingestUrl ?? DEFAULT_INGEST_URL;
  const graphClient = createGraphClient({
    syncUrl: resolvedIngestUrl.replace(/\/events\/?$/, '/graph/sync'),
    apiKey: config.apiKey,
    projectId: config.apiKey,
    sessionId: readSntUid(),
  });

  // Persisted page-node state from a previous page load is restored by the graph
  // client's own constructor (it reads `_snt_graph_nodes` on creation). We no
  // longer re-read the key and call restore() here — that was a redundant second
  // load path that cleared and reloaded identical data.

  void domScanner.scan().then((result) => {
    for (const node of result.nodes) {
      graphClient.addPageNode({
        id: node.componentId,
        componentId: node.componentId,
        semanticType: node.semanticType,
        answers: node.headingText ? [node.headingText] : [],
        prominenceScore: node.prominenceScore,
        depth: node.depth,
      });
    }
    for (const edge of result.edges) {
      graphClient.addStructuralEdge(edge);
    }
    graphClient.syncOnce();
  });

  let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedSync = (): void => {
    if (syncDebounceTimer !== null) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => {
      syncDebounceTimer = null;
      graphClient.syncOnce();
    }, 500);
  };

  domScanner.observe((event) => {
    for (const node of event.nodes) {
      graphClient.addPageNode({
        id: node.componentId,
        componentId: node.componentId,
        semanticType: node.semanticType,
        answers: node.headingText ? [node.headingText] : [],
        prominenceScore: node.prominenceScore,
        depth: node.depth,
      });
    }
    for (const edge of event.edges) {
      graphClient.addStructuralEdge(edge);
    }
    debouncedSync();
  });

  // Tears down only the graph resources; the caller pairs it with the lean
  // client's own dispose/destroy. Idempotent, and de-registers itself so a
  // later re-init or teardown can't run it twice on already-freed resources.
  const teardownGraph = (): void => {
    if (syncDebounceTimer !== null) {
      clearTimeout(syncDebounceTimer);
      syncDebounceTimer = null;
    }
    domScanner.destroy();
    graphClient.destroy();
    if (_graphTeardowns.get(config.apiKey) === teardownGraph) {
      _graphTeardowns.delete(config.apiKey);
    }
  };
  _graphTeardowns.set(config.apiKey, teardownGraph);

  return {
    ...client,
    getGraph: () => graphClient.snapshot(),
    dispose: () => {
      teardownGraph();
      client.dispose();
    },
    destroy: () => {
      teardownGraph();
      client.destroy();
    },
  };
}
