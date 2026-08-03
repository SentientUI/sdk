import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGraphClient, sanitizePageUrl, type PageNode } from './graph';

const pageNode = (overrides: Partial<PageNode> = {}): PageNode => ({
  id: 'node-1',
  componentId: 'hero-1',
  semanticType: 'hero',
  answers: [],
  prominenceScore: 0.8,
  depth: 0,
  ...overrides,
});

describe('createGraphClient', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('addPageNode and snapshot', () => {
    const client = createGraphClient();
    client.addPageNode(pageNode());
    const snap = client.snapshot();
    expect(snap.pageNodes).toHaveLength(1);
    expect(snap.pageNodes[0].componentId).toBe('hero-1');
  });

  it('serialize and restore round trip', () => {
    const client = createGraphClient();
    client.addPageNode(pageNode());
    const serialized = client.serialize();

    const client2 = createGraphClient();
    client2.restore(serialized);
    expect(client2.snapshot().pageNodes).toHaveLength(1);
  });

  it('syncOnce fires a single fetch with Authorization header', () => {
    const fetchMock = vi.fn().mockReturnValue(Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createGraphClient({
      syncUrl: 'https://api.example/graph/sync',
      apiKey: 'pk_test',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });
    client.addPageNode(pageNode());
    // addPageNode no longer triggers sync; syncOnce() does.
    expect(fetchMock).not.toHaveBeenCalled();

    client.syncOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example/graph/sync',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer pk_test' }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it('syncOnce sends nodes in API format', () => {
    const fetchMock = vi.fn().mockReturnValue(Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createGraphClient({ syncUrl: 'https://api.example/graph/sync', apiKey: 'pk_test' });
    client.addPageNode(pageNode({ componentId: 'hero-1', semanticType: 'hero', answers: ['Big headline'], prominenceScore: 0.9, depth: 1 }));
    client.syncOnce();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0]).toMatchObject({
      componentId: 'hero-1',
      semanticType: 'hero',
      answers: ['Big headline'],
      prominenceScore: 0.9,
      depthInPage: 1,
    });
    expect(typeof body.nodes[0].contentHash).toBe('string');
    expect(body.edges).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('syncOnce emits structural edges added via addStructuralEdge, dropping orphans', () => {
    const fetchMock = vi.fn().mockReturnValue(Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createGraphClient({ syncUrl: 'https://api.example/graph/sync', apiKey: 'pk_test' });
    client.addPageNode(pageNode({ componentId: 'header-1', semanticType: 'navigation', depth: 0 }));
    client.addPageNode(pageNode({ componentId: 'cta-1', semanticType: 'cta', depth: 1 }));
    // Valid parent → child
    client.addStructuralEdge({ fromComponentId: 'header-1', toComponentId: 'cta-1', weight: 0.6 });
    // Orphan: target node never registered, should be filtered
    client.addStructuralEdge({ fromComponentId: 'header-1', toComponentId: 'ghost', weight: 0.6 });
    client.syncOnce();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const structural = body.edges.filter((e: { type: string }) => e.type === 'structural');
    expect(structural).toHaveLength(1);
    expect(structural[0]).toMatchObject({
      fromComponentId: 'header-1',
      toComponentId: 'cta-1',
      type: 'structural',
      weight: 0.6,
    });
    vi.unstubAllGlobals();
  });

  it('syncOnce emits semantic edges when neighbour types are present', () => {
    const fetchMock = vi.fn().mockReturnValue(Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createGraphClient({ syncUrl: 'https://api.example/graph/sync', apiKey: 'pk_test' });
    client.addPageNode(pageNode({ componentId: 'pricing-1', semanticType: 'pricing', depth: 1 }));
    client.addPageNode(pageNode({ componentId: 'features-1', semanticType: 'features', depth: 1 }));
    client.addPageNode(pageNode({ componentId: 'cta-1', semanticType: 'cta', depth: 1 }));
    client.syncOnce();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // pricing ↔ features (both directions), pricing↔faq absent (no faq node),
    // cta → hero/trust/social_proof absent, but pricing → features and features → pricing exist.
    const pairs = body.edges.map((e: { fromComponentId: string; toComponentId: string }) =>
      `${e.fromComponentId}->${e.toComponentId}`,
    );
    expect(pairs).toContain('pricing-1->features-1');
    expect(pairs).toContain('features-1->pricing-1');
    expect(body.edges.every((e: { type: string }) => e.type === 'semantic')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('persist() survives localStorage.setItem throwing (quota); in-memory state intact', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    const client = createGraphClient();
    // addPageNode calls persist() which calls setItem — must not throw.
    expect(() => client.addPageNode(pageNode({ componentId: 'hero-1' }))).not.toThrow();
    expect(setItem).toHaveBeenCalled();

    // In-memory state survived even though persistence failed.
    expect(client.snapshot().pageNodes).toHaveLength(1);
    expect(client.snapshot().pageNodes[0].componentId).toBe('hero-1');

    setItem.mockRestore();
  });

  it('restore() ignores partially-corrupted JSON missing the pageNodes field', () => {
    const client = createGraphClient();
    client.addPageNode(pageNode({ componentId: 'existing-1' }));

    // Object parses fine but has no pageNodes — defaults to [], so map is cleared.
    client.restore(JSON.stringify({ somethingElse: true }));
    expect(client.snapshot().pageNodes).toHaveLength(0);
  });

  it('restore() leaves state untouched when given non-JSON garbage', () => {
    const client = createGraphClient();
    client.addPageNode(pageNode({ componentId: 'keep-1' }));

    // Throws inside JSON.parse → caught → map untouched.
    client.restore('}{ not json');
    expect(client.snapshot().pageNodes).toHaveLength(1);
    expect(client.snapshot().pageNodes[0].componentId).toBe('keep-1');
  });

  it('semantic edges emit all pairs when multiple nodes share a neighbour type', () => {
    const fetchMock = vi.fn().mockReturnValue(Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createGraphClient({ syncUrl: 'https://api.example/graph/sync', apiKey: 'pk_test' });
    // One pricing node, two features nodes → pricing must emit an edge to BOTH features.
    client.addPageNode(pageNode({ componentId: 'pricing-1', semanticType: 'pricing' }));
    client.addPageNode(pageNode({ componentId: 'features-1', semanticType: 'features' }));
    client.addPageNode(pageNode({ componentId: 'features-2', semanticType: 'features' }));
    client.syncOnce();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const pairs = body.edges.map((e: { fromComponentId: string; toComponentId: string }) =>
      `${e.fromComponentId}->${e.toComponentId}`,
    );
    expect(pairs).toContain('pricing-1->features-1');
    expect(pairs).toContain('pricing-1->features-2');
    // Both features point back to the single pricing node.
    expect(pairs).toContain('features-1->pricing-1');
    expect(pairs).toContain('features-2->pricing-1');
    vi.unstubAllGlobals();
  });

  it('syncOnce carries sessionId/projectId attribution in the payload when configured', () => {
    const fetchMock = vi.fn().mockReturnValue(Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createGraphClient({
      syncUrl: 'https://api.example/graph/sync',
      apiKey: 'pk_test',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });
    client.addPageNode(pageNode());
    client.syncOnce();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // The config surface (projectId/sessionId) is transmitted so the beacon
    // carries visitor attribution — the server tolerates the extra fields.
    expect(body.sessionId).toBe('sess-1');
    expect(body.projectId).toBe('proj-1');
    vi.unstubAllGlobals();
  });

  it('sanitizePageUrl strips query and hash', () => {
    expect(sanitizePageUrl('https://shop.example/reset?token=secret#frag')).toBe(
      'https://shop.example/reset',
    );
    expect(sanitizePageUrl('not a url')).toBe('/');
  });

  it('syncOnce sends origin+pathname only (strips query and hash)', () => {
    const fetchMock = vi.fn().mockReturnValue(Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const prev = window.location.href;
    // jsdom allows href assignment; query/hash must not appear in the payload.
    window.history.pushState({}, '', '/reset?token=secret#frag');

    const client = createGraphClient({ syncUrl: 'https://api.example/graph/sync', apiKey: 'pk_test' });
    client.addPageNode(pageNode());
    client.syncOnce();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.pageUrl).toMatch(/\/reset$/);
    expect(body.pageUrl).not.toContain('token');
    expect(body.pageUrl).not.toContain('#');
    window.history.pushState({}, '', prev);
    vi.unstubAllGlobals();
  });

  it('syncOnce omits attribution fields when they are not configured', () => {
    const fetchMock = vi.fn().mockReturnValue(Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createGraphClient({ syncUrl: 'https://api.example/graph/sync', apiKey: 'pk_test' });
    client.addPageNode(pageNode());
    client.syncOnce();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect('sessionId' in body).toBe(false);
    expect('projectId' in body).toBe(false);
    vi.unstubAllGlobals();
  });

  it('constructor loads persisted nodes from localStorage (single load path)', () => {
    // The constructor is the sole load path for _snt_graph_nodes — the graph entry
    // no longer re-reads the key and calls restore() on top of this.
    localStorage.setItem(
      '_snt_graph_nodes',
      JSON.stringify([{ id: 'p-1', componentId: 'persisted-1', semanticType: 'hero', answers: [], prominenceScore: 0.5, depth: 0 }]),
    );
    const client = createGraphClient();
    const snap = client.snapshot();
    expect(snap.pageNodes).toHaveLength(1);
    expect(snap.pageNodes[0].componentId).toBe('persisted-1');
  });

  it('syncOnce omits the Authorization header when no apiKey is configured', () => {
    const fetchMock = vi.fn().mockReturnValue(Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createGraphClient({ syncUrl: 'https://api.example/graph/sync' });
    client.addPageNode(pageNode());
    client.syncOnce();

    expect(fetchMock).toHaveBeenCalledOnce();
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
    vi.unstubAllGlobals();
  });
});
