import { deriveSessionSegment } from '@sentientui/core';
import type { SlotDeclInput, SlotResult } from '@sentientui/core';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';
import type { AdaptiveProviderProps } from '../provider.js';
import { SentientPersonaScript } from '../persona-script.js';
import {
  loadAdaptiveAssignments,
  loadAdaptiveDecision,
  type ServerAssignments,
} from '../server.js';
import { AdaptiveRootClient } from './adaptive-root-client.js';
import { buildAgentFeed, renderAgentJsonLdBody, type AgentBlock } from '../agent-feed.js';

export { createAgentFeed } from './agent-feed-route.js';
export type { AgentFeedRouteConfig, AgentFeedReadEntry } from './agent-feed-route.js';
export { sentientAgentMiddleware } from './agent-middleware.js';
export type { SentientAgentMiddlewareConfig, CrawlerRequestEntry } from './agent-middleware.js';
export { defineAgentContent, buildAgentFeed as buildAgentFeedFor } from '../agent-feed.js';
export type { AgentFeed } from '../agent-feed.js';

const DEFAULT_API_BASE_URL = 'https://api.sentient-ui.com/v1';

export type PreloadComponent = { id: string; variantIds: string[] };

export type AdaptiveRootProps = Omit<
  AdaptiveProviderProps,
  'initialAssignments' | 'onAssignment' | 'initialSlots' | 'initialPersona'
> & {
  /**
   * Components to assign server-side (SEO-safe). Optional — omit when the
   * tree uses only slots/sections, or assigns client-side via hooks.
   */
  components?: PreloadComponent[];
  /**
   * Declare page section IDs in their default order. When provided,
   * AdaptiveRoot calls `/v1/decide` (single round trip) instead of
   * individual `/v1/assign` calls, and `useLayoutOrder()` returns the
   * persona-specific order on first render.
   *
   * @example sections={['hero', 'pricing', 'features', 'social_proof']}
   */
  sections?: string[];
  /**
   * Adaptive-slot declarations used by `useAdaptiveTokens` / `AdaptiveGroup`
   * in this tree. Declaring them here decides them in the same SSR
   * round trip, so their values serialize into the server HTML.
   */
  slots?: SlotDeclInput[];
  /** App origin — must be in the project's `allowed_origins`. */
  appOrigin?: string;
  /** Override: when set no network fetch is made. Useful for tests. */
  initialAssignments?: ServerAssignments;
  /**
   * Milliseconds to wait for the API before rendering default variants.
   * Defaults to 1000. The hot path typically returns in well under 150 ms;
   * the full 1 s budget is only reached on a cold start or an API
   * geographically distant from your SSR host. Lower it if your API is
   * co-located and warm.
   */
  timeoutMs?: number;
  /**
   * When set, AdaptiveRoot emits a server-rendered inline JSON-LD block
   * describing the page's winning variants, layout order, and developer-supplied
   * content — readable by passive AI crawlers (which do not run JS). Invisible to
   * humans (a JSON-LD script renders no visible DOM). Omit to emit nothing.
   */
  agentFeed?: {
    /** Page path for the feed. Falls back to the `x-pathname` request header, then '/'. */
    path?: string;
    /** Structured page content. Falls back to the `defineAgentContent` registry for this path. */
    content?: Record<string, unknown>;
  };
  children: ReactNode;
};

/** Build agent blocks from SSR assignments (Record<id, variantId | { variantId }>). */
function assignmentsToBlocks(assignments: ServerAssignments): AgentBlock[] {
  return Object.entries(assignments as Record<string, unknown>).map(([id, v]) => ({
    id,
    variant: typeof v === 'string' ? v : ((v as { variantId?: string })?.variantId ?? ''),
  }));
}

/**
 * Next.js Server Component that resolves variant assignments (and optionally
 * section layout order) server-side for zero layout shift on first paint.
 *
 * When `sections` is provided, a single `POST /v1/decide` call returns both
 * the persona-specific section order and all component assignments.
 * Without `sections`, individual `/v1/assign` calls are made per component.
 *
 * @example
 * // app/page.tsx — with section layout
 * import { AdaptiveRoot } from '@sentientui/react/next';
 *
 * export default async function Page() {
 *   return (
 *     <AdaptiveRoot
 *       apiKey={process.env.NEXT_PUBLIC_SENTIENT_API_KEY!}
 *       context="landing"
 *       sections={['hero', 'pricing', 'features', 'social_proof']}
 *       components={[
 *         { id: 'hero_cta', variantIds: ['default', 'accent'] },
 *       ]}
 *     >
 *       <HeroSection />
 *       <PricingSection />
 *       <FeaturesSection />
 *       <SocialProofSection />
 *     </AdaptiveRoot>
 *   );
 * }
 */
export async function AdaptiveRoot(props: AdaptiveRootProps): Promise<JSX.Element> {
  const {
    components = [],
    sections,
    slots,
    appOrigin,
    initialAssignments: initialAssignmentsOverride,
    ssrSessionId: ssrSessionIdProp,
    timeoutMs,
    agentFeed,
    children,
    ...providerProps
  } = props;

  const headerStore = await headers();
  const host = headerStore.get('host');
  if (!appOrigin && process.env.NODE_ENV === 'production' && !host) {
    console.error(
      '[SentientUI] AdaptiveRoot: Host header is absent and no appOrigin was provided. ' +
      'Pass appOrigin explicitly — the https://localhost fallback will likely fail allowed_origins validation.',
    );
  }
  const resolvedOrigin = appOrigin ??
    (process.env.NODE_ENV === 'production'
      ? `https://${host ?? 'localhost'}`
      : 'http://localhost:3001');
  const userAgent = headerStore.get('user-agent') ?? undefined;
  const referer = headerStore.get('referer') ?? undefined;
  // Honor a tracking opt-out at SSR: `DNT: 1` or the legally-enforceable
  // `Sec-GPC: 1`. When set we skip the session upsert + assign/decide so no
  // session row is minted for the visitor (audit P4) — matching the client SDK,
  // which already no-ops for these signals.
  const doNotTrack = headerStore.get('dnt') === '1' || headerStore.get('sec-gpc') === '1';
  const sessionSegment = deriveSessionSegment({ userAgent, referer, appOrigin: resolvedOrigin });
  const cookieStore = await cookies();

  // SSR preload MUST hit the same API host the client will use, otherwise the
  // SSR-minted session lives on the wrong host and the client's first /assign
  // misses it and re-mints — silently breaking SSR→client continuity for any
  // non-default / self-hosted deployment. The client derives its base from
  // apiBaseUrl too (see provider.tsx), so thread the same value here.
  const baseUrl = providerProps.apiBaseUrl
    ? providerProps.apiBaseUrl.replace(/\/$/, '')
    : DEFAULT_API_BASE_URL;

  let initialAssignments: ServerAssignments;
  let initialLayoutOrder: string[] | null = null;
  let initialSlots: Record<string, SlotResult> | undefined;
  let initialPersona: { persona: string; confidence: number } | null = null;
  let ssrSessionId: string | undefined;

  if (initialAssignmentsOverride) {
    initialAssignments = initialAssignmentsOverride;
    ssrSessionId = ssrSessionIdProp;
  } else if ((sections && sections.length > 0) || (slots && slots.length > 0)) {
    const decision = await loadAdaptiveDecision({
      sections: sections ?? [],
      components,
      slots,
      cookies: cookieStore,
      apiKey: providerProps.apiKey,
      baseUrl,
      origin: resolvedOrigin,
      userAgent,
      referer,
      doNotTrack,
      timeoutMs,
    });
    initialAssignments = decision.assignments;
    initialLayoutOrder = decision.layoutOrder;
    initialSlots = decision.slots;
    initialPersona =
      decision.persona !== undefined
        ? { persona: decision.persona, confidence: decision.confidence ?? 0 }
        : null;
    ssrSessionId = decision.sessionId;
  } else {
    const result = await loadAdaptiveAssignments(components, {
      cookies: cookieStore,
      apiKey: providerProps.apiKey,
      baseUrl,
      origin: resolvedOrigin,
      userAgent,
      referer,
      doNotTrack,
      timeoutMs,
    });
    initialAssignments = result.assignments;
    ssrSessionId = result.sessionId;
  }

  // Single-writer inline script — ALWAYS the first child, before any markup
  // that CSS keyed on the persona attributes could style.
  const personaScript = (
    <SentientPersonaScript apiKey={providerProps.apiKey} persona={initialPersona} />
  );

  const client = (
    <AdaptiveRootClient
      {...providerProps}
      initialAssignments={initialAssignments}
      initialLayoutOrder={initialLayoutOrder}
      initialSlots={initialSlots}
      initialPersona={initialPersona ?? undefined}
      sessionSegment={sessionSegment}
      ssrSessionId={ssrSessionId}
    >
      {children}
    </AdaptiveRootClient>
  );

  if (!agentFeed) {
    return (
      <>
        {personaScript}
        {client}
      </>
    );
  }

  // Server-rendered inline JSON-LD for AI crawlers. Emitted only on the server
  // path so passive crawlers (no JS) see it in the raw HTML. The body escapes
  // '<' so page content cannot break out of the <script> element.
  const path = agentFeed.path ?? headerStore.get('x-pathname') ?? '/';
  const feed = buildAgentFeed({
    page: path,
    blocks: assignmentsToBlocks(initialAssignments),
    layoutOrder: initialLayoutOrder ?? undefined,
    content: agentFeed.content,
  });

  return (
    <>
      {personaScript}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: renderAgentJsonLdBody(feed) }}
      />
      {client}
    </>
  );
}
