import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared mock instances, hoisted so the vi.mock factories can close over them.
const { leanClient, scanner, graphClient } = vi.hoisted(() => ({
  leanClient: { destroy: vi.fn(), assign: vi.fn(), goal: vi.fn() },
  scanner: { scan: vi.fn(), observe: vi.fn(), destroy: vi.fn() },
  graphClient: {
    restore: vi.fn(),
    addPageNode: vi.fn(),
    addStructuralEdge: vi.fn(),
    syncOnce: vi.fn(),
    snapshot: vi.fn(() => ({ pageNodes: [], capturedAt: 0 })),
    destroy: vi.fn(),
  },
}));

vi.mock('./index.js', () => ({
  init: vi.fn(() => leanClient),
  isDoNotTrackEnabled: vi.fn(() => false),
  detectDeviceClass: vi.fn(),
  detectTrafficSource: vi.fn(),
  detectTimeOfDay: vi.fn(),
  deriveSessionSegment: vi.fn(),
  referrerDomainFromReferer: vi.fn(),
}));
vi.mock('./scanner.js', () => ({ createDOMScanner: vi.fn(() => scanner) }));
vi.mock('./graph.js', () => ({ createGraphClient: vi.fn(() => graphClient) }));

import { init } from './index-graph.js';
import { init as initLean, isDoNotTrackEnabled } from './index.js';
import { createDOMScanner } from './scanner.js';

const SCAN_RESULT = {
  nodes: [{ componentId: 'hero', semanticType: 'hero', headingText: 'Hi', prominenceScore: 1, depth: 0 }],
  edges: [{ from: 'hero', to: 'cta', kind: 'structural', weight: 1 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  scanner.scan.mockResolvedValue(SCAN_RESULT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('index-graph init override', () => {
  it('returns the lean client untouched when graph is disabled', () => {
    const client = init({ apiKey: 'pk_test', context: 'saas' });
    expect(initLean).toHaveBeenCalledOnce();
    expect(createDOMScanner).not.toHaveBeenCalled();
    expect(client).toBe(leanClient);
  });

  // audit P1: graph sync mounts a DOM scanner that POSTs page structure and
  // reads _snt_uid — it must be gated by the same DNT/GPC/consent opt-out as the
  // lean client, even though initLean itself already no-ops.
  it('does not mount the graph scanner when DNT/GPC is enabled', () => {
    vi.mocked(isDoNotTrackEnabled).mockReturnValueOnce(true);
    const client = init({ apiKey: 'pk_test', context: 'saas', graph: true });
    expect(createDOMScanner).not.toHaveBeenCalled();
    expect(client).toBe(leanClient);
  });

  it('does not mount the graph scanner when consent is false', () => {
    const client = init({ apiKey: 'pk_test', context: 'saas', graph: true, consent: false });
    expect(createDOMScanner).not.toHaveBeenCalled();
    expect(client).toBe(leanClient);
  });

  // Keyless zero-network contract: with no api key there is nothing to feed —
  // the scanner must never mount and /v1/graph/sync must never fire.
  it('does not mount the graph scanner in keyless mode (no apiKey)', () => {
    const client = init({ apiKey: '', context: 'saas', graph: true });
    expect(createDOMScanner).not.toHaveBeenCalled();
    expect(graphClient.syncOnce).not.toHaveBeenCalled();
    expect(client).toBe(leanClient);
  });

  it('does not re-load persisted page nodes via restore() — the graph client constructor owns that', () => {
    // Persisted _snt_graph_nodes is loaded once, by createGraphClient's constructor.
    // This entry must NOT re-read the key and call restore() on top of it (that was
    // a redundant second load path that cleared and reloaded identical data).
    localStorage.setItem('_snt_graph_nodes', JSON.stringify([{ id: 'hero', componentId: 'hero' }]));
    init({ apiKey: 'pk_test', context: 'saas', graph: true });
    expect(graphClient.restore).not.toHaveBeenCalled();
  });

  it('feeds scanned nodes and edges into the graph then syncs once (no DOM text by default)', async () => {
    init({ apiKey: 'pk_test', context: 'saas', graph: true });
    await vi.waitFor(() => expect(graphClient.syncOnce).toHaveBeenCalled());
    expect(graphClient.addPageNode).toHaveBeenCalledWith(
      expect.objectContaining({ componentId: 'hero', semanticType: 'hero', answers: [] }),
    );
    expect(graphClient.addStructuralEdge).toHaveBeenCalledWith(SCAN_RESULT.edges[0]);
  });

  it('includes heading text in answers only when captureDomText is true', async () => {
    init({ apiKey: 'pk_test', context: 'saas', graph: true, captureDomText: true });
    await vi.waitFor(() => expect(graphClient.addPageNode).toHaveBeenCalled());
    expect(graphClient.addPageNode).toHaveBeenCalledWith(
      expect.objectContaining({ componentId: 'hero', answers: ['Hi'] }),
    );
  });

  it('debounces sync on mutation-observer events (500ms)', async () => {
    vi.useFakeTimers();
    init({ apiKey: 'pk_test', context: 'saas', graph: true });
    // First arg of observe() is the mutation callback.
    const onMutation = scanner.observe.mock.calls[0]![0] as (e: typeof SCAN_RESULT) => void;
    graphClient.syncOnce.mockClear();

    onMutation(SCAN_RESULT);
    onMutation(SCAN_RESULT); // rapid second event collapses into one sync
    expect(graphClient.syncOnce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(graphClient.syncOnce).toHaveBeenCalledOnce();
  });

  it('recovers from corrupt _snt_graph_nodes without throwing and never calls restore', () => {
    localStorage.setItem('_snt_graph_nodes', '}{ not valid json');
    expect(() => init({ apiKey: 'pk_test', context: 'saas', graph: true })).not.toThrow();
    // This entry no longer reads _snt_graph_nodes; corrupt state is handled by the
    // graph client constructor's own try/catch, so restore is never called here.
    expect(graphClient.restore).not.toHaveBeenCalled();
  });

  it('does not call restore when no persisted nodes exist', () => {
    init({ apiKey: 'pk_test', context: 'saas', graph: true });
    expect(graphClient.restore).not.toHaveBeenCalled();
  });

  it('debounce collapses many rapid mutation events into a single sync', async () => {
    vi.useFakeTimers();
    init({ apiKey: 'pk_test', context: 'saas', graph: true });
    const onMutation = scanner.observe.mock.calls[0]![0] as (e: typeof SCAN_RESULT) => void;
    graphClient.syncOnce.mockClear();

    for (let i = 0; i < 5; i++) onMutation(SCAN_RESULT);
    expect(graphClient.syncOnce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(499);
    expect(graphClient.syncOnce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(graphClient.syncOnce).toHaveBeenCalledOnce();
  });

  it('a mutation event after destroy() still schedules a timer but destroy already cleared the prior one', () => {
    vi.useFakeTimers();
    const client = init({ apiKey: 'pk_test', context: 'saas', graph: true });
    const onMutation = scanner.observe.mock.calls[0]![0] as (e: typeof SCAN_RESULT) => void;

    onMutation(SCAN_RESULT); // arm a debounce
    client.destroy();        // clears the pending timer
    graphClient.syncOnce.mockClear();

    vi.advanceTimersByTime(500);
    // The pending sync was cancelled by destroy(); nothing fires.
    expect(graphClient.syncOnce).not.toHaveBeenCalled();
  });

  it('exposes getGraph and a destroy that clears the timer and tears down everything', () => {
    vi.useFakeTimers();
    const client = init({ apiKey: 'pk_test', context: 'saas', graph: true });
    expect(client.getGraph()).toEqual({ pageNodes: [], capturedAt: 0 });

    const onMutation = scanner.observe.mock.calls[0]![0] as (e: typeof SCAN_RESULT) => void;
    onMutation(SCAN_RESULT); // schedule a debounced sync
    graphClient.syncOnce.mockClear();

    client.destroy();
    expect(scanner.destroy).toHaveBeenCalledOnce();
    expect(graphClient.destroy).toHaveBeenCalledOnce();
    expect(leanClient.destroy).toHaveBeenCalledOnce();

    // Pending debounce was cleared, so no late sync fires.
    vi.advanceTimersByTime(500);
    expect(graphClient.syncOnce).not.toHaveBeenCalled();
  });

  // A re-init for the same key (HMR, consent toggle, provider remount) must tear
  // down the previous mount's DOM scanner + MutationObserver + debounce timer.
  // The lean client's own re-init guard only knows about its queue/listeners —
  // the graph resources live in this entry and would otherwise leak.
  it('tears down the previous scanner and graph client when re-initialized for the same key', () => {
    init({ apiKey: 'pk_test', context: 'saas', graph: true });
    expect(scanner.destroy).not.toHaveBeenCalled();
    expect(graphClient.destroy).not.toHaveBeenCalled();

    init({ apiKey: 'pk_test', context: 'saas', graph: true });
    expect(scanner.destroy).toHaveBeenCalledTimes(1);
    expect(graphClient.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not tear down a still-live graph mount under a different key', () => {
    init({ apiKey: 'pk_one', context: 'saas', graph: true });
    init({ apiKey: 'pk_two', context: 'saas', graph: true });
    // Distinct keys are independent mounts — neither supersedes the other.
    expect(scanner.destroy).not.toHaveBeenCalled();
    expect(graphClient.destroy).not.toHaveBeenCalled();
  });
});
