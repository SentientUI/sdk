import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { init } from './index.js';
import { readSnapshot, writeSnapshot } from './snapshot.js';

const BASE_CONFIG = {
  apiKey: 'pk_test_abc123',
  ingestUrl: 'https://api.example.com/v1/events',
  context: 'saas' as const,
};

function resetHtmlAttrs(): void {
  document.documentElement.removeAttribute('data-sentient-persona');
  document.documentElement.removeAttribute('data-sentient-confidence');
}

beforeEach(() => {
  localStorage.clear();
  resetHtmlAttrs();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetHtmlAttrs();
});

describe('initialSlots / getSlotResult', () => {
  it('seeds getSlotResult from config.initialSlots', () => {
    const client = init({
      ...BASE_CONFIG,
      initialSlots: { hero: { tone: 'urgent' }, 'pricing-area': 'social_first' },
    });
    expect(client.getSlotResult('hero')).toEqual({ tone: 'urgent' });
    expect(client.getSlotResult('pricing-area')).toBe('social_first');
    expect(client.getSlotResult('undeclared')).toBeNull();
    client.destroy();
  });

  it('fills gaps from the snapshot but initialSlots win', () => {
    writeSnapshot(BASE_CONFIG.apiKey, {
      v: 1,
      persona: 'persona_a',
      band: 'medium',
      slots: { hero: { tone: 'calm' }, faq: 'expanded' },
      layoutOrder: null,
      savedAt: Date.now(),
    });
    const client = init({ ...BASE_CONFIG, initialSlots: { hero: { tone: 'urgent' } } });
    expect(client.getSlotResult('hero')).toEqual({ tone: 'urgent' }); // SSR wins
    expect(client.getSlotResult('faq')).toBe('expanded');             // snapshot fills
    client.destroy();
  });

  it('resolves failed-decide slots to their baseline via getSlotResult', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).endsWith('/decide')
          ? ({ ok: false, status: 500, json: async () => ({}) } as Response)
          : ({ ok: true, json: async () => ({}) } as Response),
      ),
    ));
    const client = init({ ...BASE_CONFIG });
    const outcome = await client.decide({
      slots: [{ id: 'hero', dims: { tone: ['calm', 'urgent'] } }],
    });
    expect(outcome).toBeNull();
    expect(client.getSlotResult('hero')).toEqual({ tone: 'calm' });
    client.destroy();
  });
});

// Only a DECIDED result has a slot_decisions row, so only a decided result may
// be exposed. The React gates read isSlotDecided to tell a decision for this
// session (SSR seed, decide response) from a result the core merely holds
// (last visit's snapshot, the failure baseline) — exposing the latter trained
// arms the server never served this session.
describe('isSlotDecided (exposure provenance)', () => {
  it('is true for SSR initialSlots and false for snapshot-seeded results', () => {
    writeSnapshot(BASE_CONFIG.apiKey, {
      v: 1,
      persona: 'persona_a',
      band: 'medium',
      slots: { faq: 'expanded' },
      layoutOrder: null,
      savedAt: Date.now(),
    });
    const client = init({ ...BASE_CONFIG, initialSlots: { hero: { tone: 'urgent' } } });
    expect(client.isSlotDecided!('hero')).toBe(true);
    expect(client.getSlotResult('faq')).toBe('expanded');
    expect(client.isSlotDecided!('faq')).toBe(false);
    expect(client.isSlotDecided!('never-seen')).toBe(false);
    client.destroy();
  });

  it('stays false for a failure baseline and flips true once a decide serves the slot', async () => {
    let fail = true;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (!String(input).endsWith('/decide')) return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      return Promise.resolve(
        fail
          ? ({ ok: false, status: 500, json: async () => ({}) } as Response)
          : ({ ok: true, json: async () => ({ slots: { hero: { tone: 'urgent' } } }) } as Response),
      );
    }));
    const client = init({ ...BASE_CONFIG });
    const decl = { id: 'hero', dims: { tone: ['calm', 'urgent'] } };
    await client.decide({ slots: [decl] });
    expect(client.getSlotResult('hero')).toEqual({ tone: 'calm' }); // renders the baseline…
    expect(client.isSlotDecided!('hero')).toBe(false);              // …but is not a trial

    fail = false;
    await client.decide({ slots: [decl] });
    expect(client.getSlotResult('hero')).toEqual({ tone: 'urgent' });
    expect(client.isSlotDecided!('hero')).toBe(true);
    client.destroy();
  });
});

describe('initialPersona / getPersona', () => {
  it('returns persona with computed band from config.initialPersona', () => {
    const client = init({ ...BASE_CONFIG, initialPersona: { persona: 'admin', confidence: 0.8 } });
    expect(client.getPersona()).toEqual({ persona: 'admin', confidence: 0.8, band: 'high' });
    client.destroy();
  });

  it('adopts documentElement.dataset when no initialPersona (single-writer adoption)', () => {
    document.documentElement.setAttribute('data-sentient-persona', 'trial_user');
    document.documentElement.setAttribute('data-sentient-confidence', 'medium');
    const client = init({ ...BASE_CONFIG });
    const p = client.getPersona();
    expect(p?.persona).toBe('trial_user');
    expect(p?.band).toBe('medium');
    // Band-consistent numeric confidence: band(confidence) === band.
    expect(p!.confidence).toBeGreaterThanOrEqual(0.3);
    expect(p!.confidence).toBeLessThan(0.7);
    client.destroy();
  });

  it('falls back to the snapshot when neither config nor dataset have a persona', () => {
    writeSnapshot(BASE_CONFIG.apiKey, {
      v: 1, persona: 'evaluator', band: 'low', slots: {}, layoutOrder: null, savedAt: Date.now(),
    });
    const client = init({ ...BASE_CONFIG });
    const p = client.getPersona();
    expect(p?.persona).toBe('evaluator');
    expect(p?.band).toBe('low');
    client.destroy();
  });

  it('returns null when nothing is known, and never writes the html attributes', () => {
    const client = init({ ...BASE_CONFIG, initialPersona: { persona: 'admin', confidence: 1 } });
    expect(document.documentElement.hasAttribute('data-sentient-persona')).toBe(false);
    client.destroy();
    const client2 = init({ ...BASE_CONFIG });
    expect(client2.getPersona()).toBeNull();
    client2.destroy();
  });

  it('updates getPersona after a successful decide', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          String(input).endsWith('/decide')
            ? { layoutOrder: null, assignments: {}, slots: {}, persona: 'admin', confidence: 0.25 }
            : {},
      } as Response),
    ));
    const client = init({ ...BASE_CONFIG });
    await client.decide({ sections: ['hero'] });
    expect(client.getPersona()).toEqual({ persona: 'admin', confidence: 0.25, band: 'low' });
    client.destroy();
  });
});

describe('componentGoal slot fallback', () => {
  function captureEvents(): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, opts?: RequestInit) => {
      if (String(url).includes('/events') && opts?.body) {
        for (const e of JSON.parse(opts.body as string) as Array<Record<string, unknown>>) {
          events.push(e);
        }
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    }));
    return events;
  }

  async function flush(client: { destroy(): void }): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    client.destroy();
    await new Promise((r) => setTimeout(r, 0));
  }

  it('attributes the goal to the slot arm when no variant assignment exists', async () => {
    const events = captureEvents();
    const client = init({
      ...BASE_CONFIG,
      initialSlots: { hero: { tone: 'urgent', motion: 'none' } },
    });
    client.componentGoal('hero', 'buy_click');
    await flush(client);

    const goals = events.filter((e) => e.eventType === 'goal_achieved');
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({
      componentId: 'hero',
      variantId: 'motion=none|tone=urgent', // canonical arm of the slot result
      goalType: 'buy_click',
    });
  });

  it('still no-ops (with debug warning path) when neither assignment nor slot exists', async () => {
    const events = captureEvents();
    const client = init({ ...BASE_CONFIG });
    client.componentGoal('never_rendered', 'x');
    await flush(client);
    expect(events.filter((e) => e.eventType === 'goal_achieved')).toHaveLength(0);
  });

  it('refuses to attribute a goal or an exposure to a slot arm the core only holds (no decision this session)', async () => {
    // A snapshot-seeded arm renders but has no slot_decisions row; a goal or
    // impression on it would be a conversion/trial for an arm never served.
    writeSnapshot(BASE_CONFIG.apiKey, {
      v: 1, persona: 'persona_a', band: 'medium', slots: { faq: 'expanded' }, layoutOrder: null, savedAt: Date.now(),
    });
    const events = captureEvents();
    const client = init({ ...BASE_CONFIG, initialSlots: { hero: { tone: 'urgent' } } });
    expect(client.getSlotResult('faq')).toBe('expanded');
    client.componentGoal('faq', 'open');
    client.track({ projectId: BASE_CONFIG.apiKey, componentId: 'faq', variantId: 'expanded', eventType: 'variant_assigned', payload: {} });
    // The SSR-decided slot and an unknown (variant) component still pass through.
    client.componentGoal('hero', 'buy_click');
    client.track({ projectId: BASE_CONFIG.apiKey, componentId: 'cta_variant', variantId: 'b', eventType: 'variant_assigned', payload: {} });
    await flush(client);

    const byComponent = (id: string) => events.filter((e) => e.componentId === id);
    expect(byComponent('faq')).toHaveLength(0);
    expect(byComponent('hero').map((e) => e.eventType)).toEqual(['goal_achieved']);
    expect(byComponent('cta_variant').map((e) => e.eventType)).toEqual(['variant_assigned']);
  });
});

describe('slotConfig / palette exposure', () => {
  const CFG_ENTRY = { kind: 'arms' as const, content: 'Generated headline' };
  const PALETTE = { primaryBg: '#111827', primaryText: '#ffffff', radius: '4px' };

  it('returns null before any decide, seed, or snapshot', () => {
    const client = init({ ...BASE_CONFIG });
    expect(client.getSlotConfig('hero')).toBeNull();
    expect(client.getSitePalette()).toBeNull();
    client.destroy();
  });

  it('seeds from config.initialSlotConfig / initialPalette', () => {
    const client = init({ ...BASE_CONFIG, initialSlotConfig: { hero: CFG_ENTRY }, initialPalette: PALETTE });
    expect(client.getSlotConfig('hero')).toEqual(CFG_ENTRY);
    expect(client.getSitePalette()).toEqual(PALETTE);
    client.destroy();
  });

  it('fills from the snapshot but initialSlotConfig wins per slot', () => {
    writeSnapshot(BASE_CONFIG.apiKey, {
      v: 1,
      persona: 'persona_a',
      band: 'medium',
      slots: {},
      layoutOrder: null,
      savedAt: Date.now(),
      slotConfig: { hero: { kind: 'arms', content: 'Snapshot headline' }, faq: { kind: 'arms', content: 'FAQ copy' } },
      palette: PALETTE,
    });
    const client = init({ ...BASE_CONFIG, initialSlotConfig: { hero: CFG_ENTRY } });
    expect(client.getSlotConfig('hero')).toEqual(CFG_ENTRY);
    expect(client.getSlotConfig('faq')).toEqual({ kind: 'arms', content: 'FAQ copy' });
    expect(client.getSitePalette()).toEqual(PALETTE);
    client.destroy();
  });

  it('populates from a decide response and persists into the snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).endsWith('/decide')
          ? ({
              ok: true,
              json: async () => ({
                slots: { hero: 'evaluator_v1' },
                slotConfig: { hero: CFG_ENTRY },
                palette: PALETTE,
                persona: 'evaluator',
                confidence: 0.8,
              }),
            } as Response)
          : ({ ok: true, json: async () => ({}) } as Response),
      ),
    ));
    const client = init({ ...BASE_CONFIG });
    await client.decide({ slotsFrom: 'registry' });
    expect(client.getSlotConfig('hero')).toEqual(CFG_ENTRY);
    expect(client.getSitePalette()).toEqual(PALETTE);

    // The next visit's pre-paint reads the snapshot — it must carry both.
    // (destroy() is forget-me and deletes the snapshot, so read it before.)
    const snap = readSnapshot(BASE_CONFIG.apiKey);
    expect(snap?.slotConfig).toEqual({ hero: CFG_ENTRY });
    expect(snap?.palette).toEqual(PALETTE);
    client.destroy();
  });
});

describe('reportSlots (first-seen registration)', () => {
  it('batches one POST per tick and never re-reports an id', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    fetchMock.mockClear(); // ignore init-time traffic

    client.reportSlots(['hero-headline']);
    client.reportSlots(['pricing-cta', 'hero-headline']);
    await vi.advanceTimersByTimeAsync(1100);

    const reports = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/slots/observed'));
    expect(reports).toHaveLength(1);
    expect(JSON.parse(String(reports[0]![1]?.body))).toEqual({ slotIds: ['hero-headline', 'pricing-cta'], pagePaths: { 'hero-headline': '/', 'pricing-cta': '/' } });

    client.reportSlots(['hero-headline']); // already reported — must not re-fire
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/slots/observed'))).toHaveLength(1);

    client.destroy();
    vi.useRealTimers();
  });

  it('refuses invalid ids client-side so co-batched valid ids still register', async () => {
    // The server 400s the WHOLE batch on one bad id, and by then every valid
    // co-batched id was already in the reported set — never retried for the
    // client lifetime, with the fetch error swallowed. Bad ids must not board.
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.mocked(console.warn);
    const client = init({ ...BASE_CONFIG });
    fetchMock.mockClear();
    warn.mockClear();

    client.reportSlots(['hero.cta', 'valid-slot', '_leading', 'a'.repeat(129), 'héro']);
    await vi.advanceTimersByTimeAsync(1100);

    const reports = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/slots/observed'));
    expect(reports).toHaveLength(1);
    expect(JSON.parse(String(reports[0]![1]?.body))).toEqual({ slotIds: ['valid-slot'], pagePaths: { 'valid-slot': '/' } });

    // One dev warning per invalid id, naming the id and the allowed shape.
    const invalidWarns = warn.mock.calls.filter((c) => String(c[0]).includes('will not register'));
    expect(invalidWarns).toHaveLength(4);
    expect(String(invalidWarns[0]![0])).toContain('hero.cta');
    expect(String(invalidWarns[0]![0])).toContain('[a-zA-Z0-9]');

    client.reportSlots(['hero.cta']); // repeat — warned once, stays silent
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('will not register'))).toHaveLength(4);

    client.destroy();
    vi.useRealTimers();
  });

  it('carries normalized baseline text with the FIRST report of an id only', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    fetchMock.mockClear();

    client.reportSlots(['hero-cta'], { 'hero-cta': '  Start\n  your   free trial  ' });
    // Text for an id not being reported is ignored; empty text is dropped.
    client.reportSlots(['pricing-cta'], { 'pricing-cta': '   ', other: 'x' });
    await vi.advanceTimersByTimeAsync(1100);

    const reports = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/slots/observed'));
    expect(reports).toHaveLength(1);
    expect(JSON.parse(String(reports[0]![1]?.body))).toEqual({
      slotIds: ['hero-cta', 'pricing-cta'],
      baselineTexts: { 'hero-cta': 'Start your free trial' },
      pagePaths: { 'hero-cta': '/', 'pricing-cta': '/' }, // the page each region lives on (Redesign page context)
      // A baseline-text vote only counts once this session is scored human (server C8).
      sessionId: expect.any(String),
    });

    // Re-reporting with a (different) text must not re-fire or resend text.
    client.reportSlots(['hero-cta'], { 'hero-cta': 'poisoned later' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/slots/observed'))).toHaveLength(1);

    client.destroy();
    vi.useRealTimers();
  });

  it('caps baseline text at 400 chars before it leaves the page', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    fetchMock.mockClear();

    client.reportSlots(['long-slot'], { 'long-slot': 'x'.repeat(1000) });
    await vi.advanceTimersByTimeAsync(1100);

    const reports = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/slots/observed'));
    const body = JSON.parse(String(reports[0]![1]?.body)) as { baselineTexts: Record<string, string> };
    expect(body.baselineTexts['long-slot']!.length).toBe(400);

    client.destroy();
    vi.useRealTimers();
  });

  it('sends every pending id in chunks of 20 instead of dropping ids 21+', async () => {
    // slice(0, 20) + clear() used to drop the tail permanently: already marked
    // reported, never sent, never retried. 45 ids must produce 3 chunked POSTs.
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    fetchMock.mockClear();

    client.reportSlots(Array.from({ length: 45 }, (_, i) => `slot-${i}`));
    await vi.advanceTimersByTimeAsync(1100);

    const reports = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/slots/observed'));
    expect(reports).toHaveLength(3);
    const batches = reports.map((c) => (JSON.parse(String(c[1]?.body)) as { slotIds: string[] }).slotIds);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(20); // server MAX_BATCH
    const sent = batches.flat();
    expect(sent).toHaveLength(45);
    expect(new Set(sent).size).toBe(45);

    client.destroy();
    vi.useRealTimers();
  });
});
describe('requestSlots (mounted-slot registry decide)', () => {
  function stubDecide(response: Record<string, unknown>) {
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        String(input).endsWith('/decide')
          ? ({ ok: true, json: async () => response } as Response)
          : ({ ok: true, json: async () => ({}) } as Response),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const decideBodies = (m: ReturnType<typeof vi.fn>) =>
    m.mock.calls.filter((c) => String(c[0]).endsWith('/decide')).map((c) => JSON.parse(String((c[1] as RequestInit).body)));

  it('batches a tick of mounts into ONE decide scoped to exactly those ids, once per id', async () => {
    // Unscoped registry mode decides every published slot — a close-out trial
    // for slots the visitor never had on screen.
    vi.useFakeTimers();
    const fetchMock = stubDecide({ slots: { hero: 'alt' }, slotConfig: { hero: { kind: 'arms', content: 'Hi' } } });
    const client = init({ ...BASE_CONFIG });
    const listener = vi.fn();
    client.onSlotsChanged!(listener);

    client.requestSlots!(['hero']);
    client.requestSlots!(['pricing', 'hero']);
    await vi.advanceTimersByTimeAsync(10);

    const bodies = decideBodies(fetchMock);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ slotsFrom: 'registry', registrySlotIds: ['hero', 'pricing'] });
    expect(client.getSlotConfig('hero')).toEqual({ kind: 'arms', content: 'Hi' });
    expect(listener).toHaveBeenCalled();

    client.requestSlots!(['hero']);
    await vi.advanceTimersByTimeAsync(10);
    expect(decideBodies(fetchMock)).toHaveLength(1);

    client.destroy();
    vi.useRealTimers();
  });

  it('registers ids with nothing published, carrying their baseline text', async () => {
    vi.useFakeTimers();
    const fetchMock = stubDecide({ slots: {}, persona: 'unknown' });
    const client = init({ ...BASE_CONFIG });
    client.requestSlots!(['hero'], { hero: 'Start free trial' });
    await vi.advanceTimersByTimeAsync(1100);

    const reports = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/slots/observed'));
    expect(reports).toHaveLength(1);
    expect(JSON.parse(String((reports[0]![1] as RequestInit).body))).toEqual({
      slotIds: ['hero'],
      baselineTexts: { hero: 'Start free trial' },
      pagePaths: { hero: '/' },
      sessionId: expect.any(String),
    });
    client.destroy();
    vi.useRealTimers();
  });

  it('drops a snapshot-seeded config the server no longer publishes', async () => {
    // Otherwise an archived slot keeps rendering its old version from
    // localStorage on every visit.
    writeSnapshot(BASE_CONFIG.apiKey, {
      v: 1, persona: 'unknown', band: 'low', slots: { hero: 'old' }, layoutOrder: null, savedAt: Date.now(),
      slotConfig: { hero: { kind: 'arms', content: 'Old headline' } },
    });
    vi.useFakeTimers();
    stubDecide({ slots: {}, persona: 'unknown' });
    const client = init({ ...BASE_CONFIG });
    expect(client.getSlotConfig('hero')).not.toBeNull();

    client.requestSlots!(['hero']);
    await vi.advanceTimersByTimeAsync(10);
    expect(client.getSlotConfig('hero')).toBeNull();
    expect(client.getSlotResult('hero')).toBeNull();
    expect(readSnapshot(BASE_CONFIG.apiKey)?.slotConfig?.hero).toBeUndefined();
    client.destroy();
    vi.useRealTimers();
  });

  it('a failed decide registers nothing', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).endsWith('/decide')
          ? ({ ok: false, status: 500, json: async () => ({}) } as Response)
          : ({ ok: true, json: async () => ({}) } as Response),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    client.requestSlots!(['hero']);
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/slots/observed'))).toBe(false);
    client.destroy();
    vi.useRealTimers();
  });

  it('retries a failed batch with backoff, then serves the decision once the server answers', async () => {
    // "Once per id" used to be keyed on the ASK: a 5xx during first render
    // left the slot on baseline/snapshot — unexposed, untrained — for the
    // whole client lifetime, and a remount never re-asked either.
    vi.useFakeTimers();
    let failures = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (!String(input).endsWith('/decide')) return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      if (failures < 1) { failures++; return Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as Response); }
      return Promise.resolve({ ok: true, json: async () => ({ slots: { hero: 'alt' }, slotConfig: { hero: { kind: 'arms', content: 'Hi' } } }) } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    client.requestSlots!(['hero'], { hero: 'Baseline' });
    await vi.advanceTimersByTimeAsync(10);
    expect(decideBodies(fetchMock)).toHaveLength(1);
    expect(client.getSlotConfig('hero')).toBeNull();

    // Backoff (2 s after the first failure), then the automatic retry lands.
    await vi.advanceTimersByTimeAsync(2100);
    expect(decideBodies(fetchMock)).toHaveLength(2);
    expect(decideBodies(fetchMock)[1]).toMatchObject({ registrySlotIds: ['hero'] });
    expect(client.getSlotConfig('hero')).toEqual({ kind: 'arms', content: 'Hi' });
    expect(client.isSlotDecided!('hero')).toBe(true);
    client.destroy();
    vi.useRealTimers();
  });

  it('cancelSlots withdraws an id that unmounted before the batch was sent, and only then', async () => {
    // A slot that mounts and unmounts inside one tick (redirecting route,
    // StrictMode probe) is not on the page — deciding it would mint a trial
    // with no exposure. Once the request is in flight the id stays marked so
    // a remount does not duplicate the answer.
    vi.useFakeTimers();
    const fetchMock = stubDecide({ slots: { hero: 'alt' }, slotConfig: { hero: { kind: 'arms', content: 'Hi' } } });
    const client = init({ ...BASE_CONFIG });
    client.requestSlots!(['hero', 'gone']);
    client.cancelSlots!(['gone']);
    await vi.advanceTimersByTimeAsync(10);
    expect(decideBodies(fetchMock)).toHaveLength(1);
    expect(decideBodies(fetchMock)[0]).toMatchObject({ registrySlotIds: ['hero'] });

    // Withdrawn ids are free to be asked again by a later mount…
    client.requestSlots!(['gone']);
    await vi.advanceTimersByTimeAsync(10);
    expect(decideBodies(fetchMock)).toHaveLength(2);
    // …but cancelling an already-sent id is a no-op: no re-ask on remount.
    client.cancelSlots!(['hero']);
    client.requestSlots!(['hero']);
    await vi.advanceTimersByTimeAsync(10);
    expect(decideBodies(fetchMock)).toHaveLength(2);
    client.destroy();
    vi.useRealTimers();
  });

  it('bounds automatic retries, but a remount still re-asks after they are spent', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).endsWith('/decide')
          ? ({ ok: false, status: 503, json: async () => ({}) } as Response)
          : ({ ok: true, json: async () => ({}) } as Response),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    client.requestSlots!(['hero']);
    // Initial + 2 automatic retries (2 s, 4 s), then it stops on its own.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(decideBodies(fetchMock)).toHaveLength(3);
    // A later mount (SPA navigation back) is a fresh ask, not a dead id.
    client.requestSlots!(['hero']);
    await vi.advanceTimersByTimeAsync(10);
    expect(decideBodies(fetchMock)).toHaveLength(4);
    client.destroy();
    vi.useRealTimers();
  });
});

describe('decideSlots (mounted request-declared slots)', () => {
  it('batches a tick of mounts into ONE decide with those declarations, once per id', async () => {
    // Keyed clients never decided request-declared slots client-side, so
    // useAdaptiveTokens / AdaptiveGroup served baseline all session without an
    // SSR `slots` preload.
    vi.useFakeTimers();
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        String(input).endsWith('/decide')
          ? ({ ok: true, json: async () => ({ slots: { hero: { tone: 'urgent' } } }) } as Response)
          : ({ ok: true, json: async () => ({}) } as Response),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    const listener = vi.fn();
    client.onSlotsChanged!(listener);
    const hero = { id: 'hero', dims: { tone: ['calm', 'urgent'] } };
    const group = { id: 'pricing-area', arms: ['standard', 'social_first'] };

    client.decideSlots!([hero]);
    client.decideSlots!([group, hero]);
    await vi.advanceTimersByTimeAsync(10);

    const bodies = fetchMock.mock.calls
      .filter((c) => String(c[0]).endsWith('/decide'))
      .map((c) => JSON.parse(String(c[1]?.body)));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].slots.map((s: { id: string }) => s.id)).toEqual(['hero', 'pricing-area']);
    expect(bodies[0].slotsFrom).toBeUndefined();
    expect(client.getSlotResult('hero')).toEqual({ tone: 'urgent' });
    expect(listener).toHaveBeenCalled();

    client.decideSlots!([hero]);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/decide'))).toHaveLength(1);
    client.destroy();
    vi.useRealTimers();
  });

  it('a failed batch renders the baseline undecided, then retries with backoff', async () => {
    vi.useFakeTimers();
    let failures = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (!String(input).endsWith('/decide')) return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      if (failures < 1) { failures++; return Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as Response); }
      return Promise.resolve({ ok: true, json: async () => ({ slots: { hero: { tone: 'urgent' } } }) } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    const hero = { id: 'hero', dims: { tone: ['calm', 'urgent'] } };
    client.decideSlots!([hero]);
    await vi.advanceTimersByTimeAsync(10);
    // Failure path: baseline renders but is not a decision (no exposure).
    expect(client.getSlotResult('hero')).toEqual({ tone: 'calm' });
    expect(client.isSlotDecided!('hero')).toBe(false);

    await vi.advanceTimersByTimeAsync(2100);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/decide'))).toHaveLength(2);
    expect(client.getSlotResult('hero')).toEqual({ tone: 'urgent' });
    expect(client.isSlotDecided!('hero')).toBe(true);
    client.destroy();
    vi.useRealTimers();
  });
});

describe('native generation: render caps, skeletons, drift', () => {
  const SKELETON = {
    v: 1 as const,
    root: { tag: 'div', classes: '', ambientBg: null, ambientText: '' },
    nodes: [{ tag: 'a', role: 'action' as const, text: 'Book', classes: 'btn', color: '', group: 0, restylable: true }],
    leaves: ['Book'],
    leafToNode: [0],
    fp: '0123456789abcdef',
  };
  const bodiesTo = (m: ReturnType<typeof vi.fn>, path: string) =>
    m.mock.calls.filter((c) => String(c[0]).endsWith(path)).map((c) => JSON.parse(String((c[1] as RequestInit).body)));

  it('requestSlots sends the page\'s render caps with the scoped decide', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slots: {}, slotConfig: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    client.requestSlots!(['hero'], undefined, { render: { hero: { fp: 'a'.repeat(16), forms: false, compose: false } } });
    await vi.advanceTimersByTimeAsync(10);
    expect(bodiesTo(fetchMock, '/decide')[0]).toMatchObject({ render: { hero: { fp: 'aaaaaaaaaaaaaaaa', forms: false, compose: false } } });
    client.destroy();
    vi.useRealTimers();
  });

  it('reportSlots carries the skeleton with the first report of an id', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    client.reportSlots(['x'], { x: 'Book' }, { x: SKELETON });
    await vi.advanceTimersByTimeAsync(1100);
    expect(bodiesTo(fetchMock, '/slots/observed')[0]).toMatchObject({ slotIds: ['x'], baselineSkeletons: { x: SKELETON } });
    client.destroy();
    vi.useRealTimers();
  });

  it('a published slot flagged needsSkeleton gets one reported', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        json: async () => (String(input).endsWith('/decide') ? { slots: { hero: 'b' }, slotConfig: { hero: { kind: 'arms', needsSkeleton: true } } } : {}),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    client.requestSlots!(['hero'], undefined, { skeletons: { hero: SKELETON } });
    await vi.advanceTimersByTimeAsync(10);
    expect(bodiesTo(fetchMock, '/slots/observed')).toEqual([{ slotIds: ['hero'], baselineSkeletons: { hero: SKELETON } }]);
    client.destroy();
    vi.useRealTimers();
  });

  it('reportDrift sends once per (slot, fingerprint)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    await vi.advanceTimersByTimeAsync(10); // let the session start
    client.reportDrift!('hero', 'a'.repeat(16), 'b'.repeat(16), 'fp_mismatch');
    client.reportDrift!('hero', 'a'.repeat(16), 'b'.repeat(16), 'fp_mismatch');
    await vi.advanceTimersByTimeAsync(10);
    const sent = bodiesTo(fetchMock, '/slots/drift');
    expect(sent).toHaveLength(1);
    expect(sent[0].reports).toEqual([{ slotId: 'hero', expectedFp: 'a'.repeat(16), observedFp: 'b'.repeat(16), reason: 'fp_mismatch' }]);
    client.destroy();
    vi.useRealTimers();
  });
});

describe('hybrid <Adaptive>: authored arms and blocked slots', () => {
  it('reports each authored arm once per (slot, key), with its text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    fetchMock.mockClear();
    client.reportSlots([], undefined, undefined, { hero: [{ key: 'quote', text: 'Get a quote' }] });
    client.reportSlots([], undefined, undefined, { hero: [{ key: 'quote', text: 'again' }] });
    const sent = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/slots/observed')).map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(sent).toEqual([{ slotIds: ['hero'], authoredArms: { hero: [{ key: 'quote', text: 'Get a quote' }] } }]);
    client.destroy();
  });

  it('keeps a blocked slot\'s reason and does not re-register it as unpublished', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        json: async () => (String(input).endsWith('/decide') ? { slots: {}, slotConfig: { hero: { kind: 'arms', blocked: 'variant_history' } } } : {}),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    client.requestSlots!(['hero'], { hero: 'Hi' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(client.getSlotConfig('hero')?.blocked).toBe('variant_history');
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/slots/observed'))).toBe(false);
    client.destroy();
    vi.useRealTimers();
  });
});

describe('Redesign: served compose + style vocabulary', () => {
  it('keeps the served vocabulary, exposes it, and snapshots it for the next pre-paint', async () => {
    vi.useFakeTimers();
    const vocabulary = { rev: 'r1', entries: [{ id: 'heading-1', role: 'heading-1', classes: 'text-4xl', computed: {}, seen: { url: '/', count: 1, at: '2026-09-23T00:00:00Z' }, source: 'editor' }], images: [] };
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          String(input).endsWith('/decide')
            ? { slots: { hero: 'unknown_v3' }, slotConfig: { hero: { kind: 'arms', compose: { unknown_v3: { tree: { type: 'heading', level: 2, like: 'heading-1', value: 'Hi' } } } } }, vocabulary }
            : {},
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = init({ ...BASE_CONFIG });
    client.requestSlots!(['hero']);
    await vi.advanceTimersByTimeAsync(10);
    expect(client.getSlotConfig('hero')?.compose?.unknown_v3?.tree).toBeDefined();
    expect(client.getStyleVocabulary!()).toEqual(vocabulary);
    expect(readSnapshot(BASE_CONFIG.apiKey)?.vocabulary).toEqual(vocabulary);
    client.destroy();
    vi.useRealTimers();
  });
});
