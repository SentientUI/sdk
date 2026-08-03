import { describe, it, expect, vi, beforeEach } from 'vitest';

// Server Component deps are all mocked so we can call AdaptiveRoot() directly
// and inspect the element it returns, without a Next.js runtime.
vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }));
vi.mock('../server.js', () => ({
  loadAdaptiveAssignments: vi.fn(),
  loadAdaptiveDecision: vi.fn(),
}));
vi.mock('./adaptive-root-client.js', () => ({ AdaptiveRootClient: vi.fn(() => null) }));
vi.mock('@sentientui/core', () => ({
  deriveSessionSegment: vi.fn(() => 'desktop:direct'),
  renderPrePaintScript: vi.fn(() => '/* snapshot pre-paint */'),
}));

import { headers, cookies } from 'next/headers';
import { loadAdaptiveAssignments, loadAdaptiveDecision } from '../server.js';
import { AdaptiveRootClient } from './adaptive-root-client.js';
import { AdaptiveRoot } from './adaptive-root.js';

const mockedHeaders = vi.mocked(headers);
const mockedCookies = vi.mocked(cookies);
const mockedDecision = vi.mocked(loadAdaptiveDecision);
const mockedAssign = vi.mocked(loadAdaptiveAssignments);

function headerStore(map: Record<string, string | undefined>) {
  return { get: (k: string) => map[k] ?? null } as unknown as Awaited<ReturnType<typeof headers>>;
}

const COMPONENTS = [{ id: 'hero_cta', variantIds: ['default', 'accent'] }];

function baseProps(extra: Record<string, unknown> = {}) {
  return {
    apiKey: 'pk_test',
    serverApiKey: 'sk_test',
    context: 'saas',
    components: COMPONENTS,
    children: null,
    ...extra,
  } as never;
}

// AdaptiveRoot now always returns a fragment: [<SentientPersonaScript/>, <AdaptiveRootClient/>]
// (plus the agent JSON-LD script when agentFeed is set).
function childrenOf(el: { props: { children: unknown } }): Array<{ type?: unknown; props?: never }> {
  const kids = el.props.children;
  return (Array.isArray(kids) ? kids : [kids]).flat().filter(Boolean).map((c) => {
    // Materialize plain function components (e.g. SentientPersonaScript) so
    // assertions can inspect the actual <script> element they produce. The
    // mocked AdaptiveRootClient is a vi.fn and is left untouched.
    const child = c as { type?: unknown; props?: Record<string, unknown> };
    if (
      typeof child.type === 'function' &&
      child.type !== (AdaptiveRootClient as unknown) &&
      !('mock' in (child.type as object))
    ) {
      return (child.type as (p: unknown) => unknown)(child.props) as { type?: unknown; props?: never };
    }
    return c;
  }) as never;
}
function clientEl(el: never): { props: Record<string, never> } {
  const found = childrenOf(el).find((c) => c && (c as { type?: unknown }).type === AdaptiveRootClient);
  if (!found) throw new Error('AdaptiveRootClient not found in AdaptiveRoot output');
  return found as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mockedHeaders.mockResolvedValue(headerStore({ host: 'shop.example.com', 'user-agent': 'UA', referer: 'https://g.co' }));
  mockedCookies.mockResolvedValue({} as never);
  mockedDecision.mockResolvedValue({
    assignments: { hero_cta: { variantId: 'accent' } },
    layoutOrder: ['pricing', 'hero'],
    sessionId: 'sess-1',
  } as never);
  mockedAssign.mockResolvedValue({
    assignments: { hero_cta: { variantId: 'default' } },
    sessionId: 'sess-2',
  } as never);
});

describe('AdaptiveRoot (Server Component)', () => {
  it('calls /v1/decide and forwards the layout order when sections are provided', async () => {
    const el = await AdaptiveRoot(baseProps({ sections: ['hero', 'pricing'], appOrigin: 'https://shop.example.com' }));

    expect(mockedDecision).toHaveBeenCalledOnce();
    expect(mockedAssign).not.toHaveBeenCalled();
    expect(clientEl(el as never)).toBeDefined();
    expect(clientEl(el as never).props.initialLayoutOrder).toEqual(['pricing', 'hero']);
    expect(clientEl(el as never).props.initialAssignments).toEqual({ hero_cta: { variantId: 'accent' } });
    expect(clientEl(el as never).props.ssrSessionId).toBe('sess-1');
    expect(clientEl(el as never).props.sessionSegment).toBe('desktop:direct');
  });

  it('falls back to per-component /v1/assign when no sections are provided', async () => {
    const el = await AdaptiveRoot(baseProps({ appOrigin: 'https://shop.example.com' }));

    expect(mockedAssign).toHaveBeenCalledOnce();
    expect(mockedDecision).not.toHaveBeenCalled();
    expect(clientEl(el as never).props.initialLayoutOrder).toBeNull();
    expect(clientEl(el as never).props.initialAssignments).toEqual({ hero_cta: { variantId: 'default' } });
    expect(clientEl(el as never).props.ssrSessionId).toBe('sess-2');
  });

  it('threads the default API base URL into the SSR decide/assign calls', async () => {
    await AdaptiveRoot(baseProps({ sections: ['hero'], appOrigin: 'https://shop.example.com' }));
    expect(mockedDecision.mock.calls[0]![0]).toMatchObject({ baseUrl: 'https://api.sentient-ui.com/v1' });

    vi.clearAllMocks();
    mockedAssign.mockResolvedValue({ assignments: {}, sessionId: 's' } as never);
    await AdaptiveRoot(baseProps({ appOrigin: 'https://shop.example.com' }));
    expect(mockedAssign.mock.calls[0]![1]).toMatchObject({ baseUrl: 'https://api.sentient-ui.com/v1' });
  });

  it('threads a custom apiBaseUrl (trailing slash stripped) into SSR so SSR and client hit the same host', async () => {
    // Regression: SSR previously hardcoded the default base, so a custom/self-
    // hosted apiBaseUrl minted the SSR session on the wrong host and the client
    // re-minted, breaking SSR→client continuity.
    await AdaptiveRoot(
      baseProps({ sections: ['hero'], appOrigin: 'https://shop.example.com', apiBaseUrl: 'https://self.host/v1/' }),
    );
    expect(mockedDecision.mock.calls[0]![0]).toMatchObject({ baseUrl: 'https://self.host/v1' });

    vi.clearAllMocks();
    mockedAssign.mockResolvedValue({ assignments: {}, sessionId: 's' } as never);
    await AdaptiveRoot(baseProps({ appOrigin: 'https://shop.example.com', apiBaseUrl: 'https://self.host/v1' }));
    expect(mockedAssign.mock.calls[0]![1]).toMatchObject({ baseUrl: 'https://self.host/v1' });
  });

  it('uses an explicit appOrigin as the request origin', async () => {
    await AdaptiveRoot(baseProps({ sections: ['hero'], appOrigin: 'https://custom.origin' }));
    expect(mockedDecision.mock.calls[0]![0]).toMatchObject({ origin: 'https://custom.origin' });
  });

  it('resolves the dev origin when no appOrigin is set and not in production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    await AdaptiveRoot(baseProps({ sections: ['hero'] }));
    expect(mockedDecision.mock.calls[0]![0]).toMatchObject({ origin: 'http://localhost:3001' });
  });

  it('derives the origin from the Host header in production when no appOrigin is set', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await AdaptiveRoot(baseProps({ sections: ['hero'] }));
    expect(mockedDecision.mock.calls[0]![0]).toMatchObject({ origin: 'https://shop.example.com' });
  });

  it('logs an error in production when the Host header is absent and no appOrigin is set', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    mockedHeaders.mockResolvedValue(
      headerStore({ host: undefined, 'user-agent': 'UA', referer: 'https://g.co' }),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // sections present -> goes through the decide branch with the localhost fallback origin.
    await AdaptiveRoot(baseProps({ sections: ['hero'] }));

    expect(errSpy).toHaveBeenCalledOnce();
    expect(String(errSpy.mock.calls[0]![0])).toContain('Host header is absent');
    // Origin falls back to https://localhost because host is missing.
    expect(mockedDecision.mock.calls[0]![0]).toMatchObject({ origin: 'https://localhost' });

    errSpy.mockRestore();
  });

  it('does not log the host error when appOrigin is provided even if Host is absent', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    mockedHeaders.mockResolvedValue(
      headerStore({ host: undefined, 'user-agent': 'UA' }),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await AdaptiveRoot(baseProps({ sections: ['hero'], appOrigin: 'https://shop.example.com' }));

    expect(errSpy).not.toHaveBeenCalled();
    expect(mockedDecision.mock.calls[0]![0]).toMatchObject({ origin: 'https://shop.example.com' });

    errSpy.mockRestore();
  });

  it('injects a server-rendered agent JSON-LD block when agentFeed is set', async () => {
    const el = await AdaptiveRoot(
      baseProps({
        appOrigin: 'https://shop.example.com',
        agentFeed: { path: '/pricing', content: { title: 'Pricing — Acme' } },
      }),
    );

    const script = childrenOf(el as never).find(
      (c) => (c as { type?: unknown; props?: { type?: string } }).type === 'script' &&
             (c as unknown as { props: { type?: string } }).props.type === 'application/ld+json',
    ) as unknown as { props: { type: string; dangerouslySetInnerHTML: { __html: string } } };
    expect(script).toBeDefined();
    expect(script.props.type).toBe('application/ld+json');
    const body = script.props.dangerouslySetInnerHTML.__html;
    expect(body).toContain('"page":"/pricing"');
    expect(body).toContain('Pricing — Acme');
    // The client provider is still rendered alongside it.
    expect(childrenOf(el as never).some((c) => (c as { type?: unknown }).type === AdaptiveRootClient)).toBe(true);
  });

  it('does not inject an agent block when agentFeed is absent (returns the client directly)', async () => {
    const el = await AdaptiveRoot(baseProps({ appOrigin: 'https://shop.example.com' }));
    expect(childrenOf(el as never).some((c) => (c as { type?: unknown }).type === 'script' && (c as { props?: { type?: string } }).props?.type === 'application/ld+json')).toBe(false);
  });

  it('renders without a components prop — the README quickstart omits it (defaults to [])', async () => {
    const { components: _omit, ...props } = baseProps({ appOrigin: 'https://shop.example.com' }) as Record<
      string,
      unknown
    >;
    const el = await AdaptiveRoot(props as never);

    expect(mockedAssign).toHaveBeenCalledOnce();
    expect(mockedAssign.mock.calls[0]![0]).toEqual([]);
    expect(clientEl(el as never)).toBeDefined();
  });

  it('skips all network fetches when initialAssignments is provided as an override', async () => {
    const override = { hero_cta: { variantId: 'override' } };
    const el = await AdaptiveRoot(baseProps({ initialAssignments: override, ssrSessionId: 'sess-override' }));

    expect(mockedDecision).not.toHaveBeenCalled();
    expect(mockedAssign).not.toHaveBeenCalled();
    expect(clientEl(el as never).props.initialAssignments).toEqual(override);
    expect(clientEl(el as never).props.ssrSessionId).toBe('sess-override');
    expect(clientEl(el as never).props.initialLayoutOrder).toBeNull();
  });
});

describe('AdaptiveRoot — persona script + slots (adaptive ladder)', () => {
  const SLOTS = [{ id: 'hero', dims: { tone: ['calm', 'urgent'] } }];

  beforeEach(() => {
    mockedDecision.mockResolvedValue({
      assignments: {},
      layoutOrder: ['hero'],
      slots: { hero: { tone: 'urgent' } },
      persona: 'buyer',
      confidence: 0.8,
      sessionId: 'sess-3',
    } as never);
  });

  it('renders the inline persona script as the FIRST child', async () => {
    const el = await AdaptiveRoot(baseProps({ sections: ['hero'], appOrigin: 'https://x.com' }));
    const kids = childrenOf(el as never);
    const first = kids[0] as { type?: unknown; props?: { dangerouslySetInnerHTML?: { __html?: string } } };
    expect(first.type).toBe('script');
    expect(String(first.props?.dangerouslySetInnerHTML?.__html)).toContain('data-sentient-persona');
  });

  it('remains the first child when agentFeed is also set', async () => {
    const el = await AdaptiveRoot(
      baseProps({ sections: ['hero'], appOrigin: 'https://x.com', agentFeed: { path: '/p' } }),
    );
    const kids = childrenOf(el as never);
    expect((kids[0] as { props?: { dangerouslySetInnerHTML?: { __html?: string } } }).props?.dangerouslySetInnerHTML?.__html).toContain('data-sentient-persona');
  });

  it('forwards slots to loadAdaptiveDecision and passes initialSlots/initialPersona to the provider', async () => {
    const el = await AdaptiveRoot(baseProps({ slots: SLOTS, appOrigin: 'https://x.com' }));
    expect(mockedDecision).toHaveBeenCalledOnce();
    expect(mockedDecision.mock.calls[0]![0]).toMatchObject({ slots: SLOTS, sections: [] });
    const client = clientEl(el as never);
    expect(client.props.initialSlots).toEqual({ hero: { tone: 'urgent' } });
    expect(client.props.initialPersona).toEqual({ persona: 'buyer', confidence: 0.8 });
  });

  it('uses the decide path when only slots are declared (no sections)', async () => {
    await AdaptiveRoot(baseProps({ slots: SLOTS, appOrigin: 'https://x.com' }));
    expect(mockedDecision).toHaveBeenCalledOnce();
    expect(mockedAssign).not.toHaveBeenCalled();
  });

  it('embeds the SSR persona in the script exactly once (no client double-write path)', async () => {
    const el = await AdaptiveRoot(baseProps({ slots: SLOTS, appOrigin: 'https://x.com' }));
    const kids = childrenOf(el as never);
    const scripts = kids.filter(
      (c) => (c as { type?: unknown }).type === 'script' &&
             String((c as { props?: { dangerouslySetInnerHTML?: { __html?: string } } }).props?.dangerouslySetInnerHTML?.__html ?? '').includes('data-sentient-persona'),
    );
    expect(scripts).toHaveLength(1); // single writer
    expect(String((scripts[0] as unknown as { props: { dangerouslySetInnerHTML: { __html: string } } }).props.dangerouslySetInnerHTML.__html)).toContain('"buyer"');
  });
});
