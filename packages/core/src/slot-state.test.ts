import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { init } from './index.js';
import { writeSnapshot } from './snapshot.js';

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
      persona: 'browser',
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

describe('initialPersona / getPersona', () => {
  it('returns persona with computed band from config.initialPersona', () => {
    const client = init({ ...BASE_CONFIG, initialPersona: { persona: 'buyer', confidence: 0.8 } });
    expect(client.getPersona()).toEqual({ persona: 'buyer', confidence: 0.8, band: 'high' });
    client.destroy();
  });

  it('adopts documentElement.dataset when no initialPersona (single-writer adoption)', () => {
    document.documentElement.setAttribute('data-sentient-persona', 'deal_seeker');
    document.documentElement.setAttribute('data-sentient-confidence', 'medium');
    const client = init({ ...BASE_CONFIG });
    const p = client.getPersona();
    expect(p?.persona).toBe('deal_seeker');
    expect(p?.band).toBe('medium');
    // Band-consistent numeric confidence: band(confidence) === band.
    expect(p!.confidence).toBeGreaterThanOrEqual(0.3);
    expect(p!.confidence).toBeLessThan(0.7);
    client.destroy();
  });

  it('falls back to the snapshot when neither config nor dataset have a persona', () => {
    writeSnapshot(BASE_CONFIG.apiKey, {
      v: 1, persona: 'researcher', band: 'low', slots: {}, layoutOrder: null, savedAt: Date.now(),
    });
    const client = init({ ...BASE_CONFIG });
    const p = client.getPersona();
    expect(p?.persona).toBe('researcher');
    expect(p?.band).toBe('low');
    client.destroy();
  });

  it('returns null when nothing is known, and never writes the html attributes', () => {
    const client = init({ ...BASE_CONFIG, initialPersona: { persona: 'buyer', confidence: 1 } });
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
            ? { layoutOrder: null, assignments: {}, slots: {}, persona: 'buyer', confidence: 0.25 }
            : {},
      } as Response),
    ));
    const client = init({ ...BASE_CONFIG });
    await client.decide({ sections: ['hero'] });
    expect(client.getPersona()).toEqual({ persona: 'buyer', confidence: 0.25, band: 'low' });
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
});
