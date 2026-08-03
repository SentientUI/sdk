import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { init } from './index.js';
import {
  __resetLocalModeLogGuards,
  LOCAL_MODE_BANNER,
} from './local-mode.js';
import { PERSONAS, fnv1a, pickDeterministicArm } from '@sentientui/policy';

const HERO_SLOT = { id: 'hero', dims: { tone: ['calm', 'urgent'] as const } };

function clearIdentity(): void {
  document.cookie = '_snt_uid=; max-age=0; path=/';
  localStorage.clear();
  sessionStorage.clear();
  delete document.documentElement.dataset.sentientPersona;
  delete document.documentElement.dataset.sentientConfidence;
}

beforeEach(() => {
  clearIdentity();
  __resetLocalModeLogGuards();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('init() localMode gating — development condition (engine resolves)', () => {
  it("missing key + localMode 'auto' (default) → local client, no network, snapshot written, banner once", async () => {
    const client = init({ apiKey: '', context: 'landing', ssrSessionId: 'sess-local-1' });
    expect(client.isLocal).toBe(true);

    const outcome = await client.decide({ slots: [HERO_SLOT] });
    expect(outcome).not.toBeNull();
    expect(outcome!.persona).toBe(PERSONAS[fnv1a('sess-local-1') % PERSONAS.length]);
    expect(outcome!.confidence).toBe(0.5);
    expect(outcome!.slots.hero).toEqual({
      tone: pickDeterministicArm(`sess-local-1:${outcome!.persona}`, 'hero.tone', ['calm', 'urgent']),
    });

    // Snapshot persisted under the keyless key.
    expect(localStorage.getItem('_snt_snap:local')).toContain('"v":1');

    // Persona attributes written (nothing else had written them).
    expect(document.documentElement.dataset.sentientPersona).toBe(outcome!.persona);
    expect(document.documentElement.dataset.sentientConfidence).toBe('medium');

    // Zero network, banner exactly once even across a second decide.
    await client.decide({ slots: [HERO_SLOT] });
    expect(fetch).not.toHaveBeenCalled();
    const bannerCalls = (console.info as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => c[0] === LOCAL_MODE_BANNER);
    expect(bannerCalls).toHaveLength(1);
  });

  it('localMode: true forces the local engine even with a valid key', async () => {
    const client = init({ apiKey: 'pk_valid', context: 'landing', localMode: true, ssrSessionId: 'sess-local-2' });
    expect(client.isLocal).toBe(true);
    await client.decide({ slots: [HERO_SLOT] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('localMode: false + missing key → existing silent no-op (warn, no local engine, no network)', () => {
    const client = init({ apiKey: '', context: 'landing', localMode: false });
    expect(client.isLocal).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      '[sentient] init() called with an invalid apiKey — expected a pk_ public key. SDK disabled.',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('valid key + default localMode → normal network client (unchanged path)', () => {
    const client = init({ apiKey: 'pk_valid', context: 'landing' });
    expect(client.isLocal).toBeUndefined();
    expect(fetch).toHaveBeenCalled(); // session upsert
  });

  it('?sentient_persona= URL override forces the local persona', async () => {
    window.history.replaceState(null, '', '/?sentient_persona=deal_seeker');
    const client = init({ apiKey: '', context: 'landing', ssrSessionId: 'sess-local-3' });
    const outcome = await client.decide({});
    expect(outcome!.persona).toBe('deal_seeker');
  });

  it('assign() resolves deterministically without network in local mode', async () => {
    const client = init({ apiKey: '', context: 'landing', ssrSessionId: 'sess-local-4' });
    const result = await client.assign('hero_cta', ['a', 'b']);
    expect(result?.variantId).toBe(pickDeterministicArm('sess-local-4', 'hero_cta', ['a', 'b']));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accumulates slot results across sequential decides (per-slot lazy decide)', async () => {
    const client = init({ apiKey: '', context: 'landing', ssrSessionId: 'sess-local-6' });
    await client.decide({ slots: [HERO_SLOT] });
    await client.decide({ slots: [{ id: 'pricing-area', arms: ['standard', 'social_first'] }] });
    // Both slots readable — the second decide must not evict the first.
    expect(client.getSlotResult('hero')).not.toBeNull();
    expect(client.getSlotResult('pricing-area')).not.toBeNull();
  });

  it('adopts pre-written persona attributes instead of rewriting (single-writer)', async () => {
    document.documentElement.dataset.sentientPersona = 'buyer';
    document.documentElement.dataset.sentientConfidence = 'high';
    const client = init({ apiKey: '', context: 'landing', ssrSessionId: 'sess-local-5' });
    await client.decide({});
    expect(document.documentElement.dataset.sentientPersona).toBe('buyer');
    expect(document.documentElement.dataset.sentientConfidence).toBe('high');
  });
});
