import { describe, it, expect, afterEach } from 'vitest';
import { applyScenario, resetScenario, confidenceBandOf } from './scenario';
import { resolveScenario } from './resolve';

type W = {
  __sentient_slot_overrides?: Record<string, unknown>;
  __sentient_persona_override?: { persona: string; confidence?: number };
};

const DECIDE = 'https://api.sentient-ui.com/v1/decide';

afterEach(() => resetScenario());

describe('applyScenario — slots + persona', () => {
  it('sets the slot/persona override globals and the persona html attributes', () => {
    applyScenario({ slots: { hero: { tone: 'urgent' } }, persona: 'buyer', confidence: 0.5 });
    const w = window as unknown as W;
    expect(w.__sentient_slot_overrides).toEqual({ hero: { tone: 'urgent' } });
    expect(w.__sentient_persona_override).toEqual({ persona: 'buyer', confidence: 0.5 });
    expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('buyer');
    expect(document.documentElement.getAttribute('data-sentient-confidence')).toBe('medium');
  });

  it('applyScenario without slots/persona clears prior forcing', () => {
    applyScenario({ slots: { hero: 'a' }, persona: 'buyer' });
    applyScenario({ variants: { x: 'y' } });
    const w = window as unknown as W;
    expect(w.__sentient_slot_overrides).toBeUndefined();
    expect(w.__sentient_persona_override).toBeUndefined();
  });

  it('resetScenario clears the new globals and the html attributes', () => {
    applyScenario({ slots: { hero: 'a' }, persona: 'buyer' });
    resetScenario();
    const w = window as unknown as W;
    expect(w.__sentient_slot_overrides).toBeUndefined();
    expect(w.__sentient_persona_override).toBeUndefined();
    expect(document.documentElement.hasAttribute('data-sentient-persona')).toBe(false);
    expect(document.documentElement.hasAttribute('data-sentient-confidence')).toBe(false);
  });

  it('confidenceBandOf matches the policy cutoffs', () => {
    expect(confidenceBandOf(0.29)).toBe('low');
    expect(confidenceBandOf(0.3)).toBe('medium');
    expect(confidenceBandOf(0.69)).toBe('medium');
    expect(confidenceBandOf(0.7)).toBe('high');
  });
});

describe('resolveScenario — /v1/decide slots', () => {
  it('serves forced slots for declared slots and echoes persona/confidence', async () => {
    const r = await resolveScenario(
      { slots: { hero: { tone: 'urgent' } }, persona: 'buyer', confidence: 0.9 },
      'POST',
      DECIDE,
      JSON.stringify({
        slots: [
          { id: 'hero', dims: { tone: ['calm', 'urgent'] } },
          { id: 'faq', arms: ['collapsed', 'expanded'] },
        ],
      }),
    );
    expect(r!.status).toBe(200);
    const json = r!.json as Record<string, unknown>;
    expect(json.slots).toEqual({ hero: { tone: 'urgent' }, faq: 'collapsed' });
    expect(json.persona).toBe('buyer');
    expect(json.confidence).toBe(0.9);
  });

  it('omits the slots key entirely when the request declared none (mirrors the server)', async () => {
    const r = await resolveScenario({}, 'POST', DECIDE, JSON.stringify({ sections: [{ id: 'hero' }] }));
    expect('slots' in (r!.json as Record<string, unknown>)).toBe(false);
  });

  it('defaults unforced slots to their declared baseline', async () => {
    const r = await resolveScenario(
      {},
      'POST',
      DECIDE,
      JSON.stringify({
        slots: [
          { id: 'g', arms: ['a', 'b'], baseline: 'b' },
          { id: 'h', dims: { tone: ['calm', 'urgent'] }, baseline: { tone: 'urgent' } },
        ],
      }),
    );
    expect((r!.json as Record<string, unknown>).slots).toEqual({ g: 'b', h: { tone: 'urgent' } });
  });

  it('/v1/explain gains slots and personaAttributes', async () => {
    const r = await resolveScenario(
      { persona: 'buyer', confidence: 0.2, slots: { hero: { tone: 'urgent' } } },
      'POST',
      'https://api.sentient-ui.com/v1/explain',
      JSON.stringify({ slots: [{ id: 'hero', dims: { tone: ['calm', 'urgent'] } }] }),
    );
    const json = r!.json as Record<string, unknown>;
    expect(json.slots).toEqual({ hero: { tone: 'urgent' } });
    expect(json.personaAttributes).toEqual({ persona: 'buyer', confidence: 'low' });
  });
});

describe('MSW server honors slot scenarios (shared resolver end-to-end)', () => {
  it('serves slots + persona through msw/node', async () => {
    const { setupSentientServer } = await import('./server');
    // Renamed binding: eslint's react-hooks plugin treats any `use` call as a
    // hook; this is msw scenario plumbing, not a hook.
    const { server, use: applyScenario } = setupSentientServer();
    try {
      applyScenario({ slots: { hero: 'b' }, persona: 'deal_seeker', confidence: 0.4 });
      const res = await fetch('https://api.sentient-ui.com/v1/decide', {
        method: 'POST',
        body: JSON.stringify({ slots: [{ id: 'hero', arms: ['a', 'b'] }] }),
      });
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.slots).toEqual({ hero: 'b' });
      expect(json.persona).toBe('deal_seeker');
      expect(json.confidence).toBe(0.4);
    } finally {
      server.close();
    }
  });
});
