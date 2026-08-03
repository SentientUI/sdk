import { describe, it, expect } from 'vitest';
import { parseSnippetConfig } from './config';

describe('parseSnippetConfig', () => {
  it('parses a full valid config', () => {
    const cfg = parseSnippetConfig({
      apiKey: 'pk_abc',
      context: 'ecommerce',
      personaAttributes: true,
      slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } },
    });
    expect(cfg).toEqual({
      apiKey: 'pk_abc',
      context: 'ecommerce',
      personaAttributes: true,
      slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } },
    });
  });

  it('returns null when apiKey is missing or not pk_-prefixed', () => {
    expect(parseSnippetConfig(undefined)).toBeNull();
    expect(parseSnippetConfig({})).toBeNull();
    expect(parseSnippetConfig({ apiKey: 'sk_secret' })).toBeNull();
    expect(parseSnippetConfig({ apiKey: 42 })).toBeNull();
  });

  it('defaults context to landing and personaAttributes to false and slots to {}', () => {
    const cfg = parseSnippetConfig({ apiKey: 'pk_abc' });
    expect(cfg).toEqual({ apiKey: 'pk_abc', context: 'landing', personaAttributes: false, slots: {} });
  });

  it('records an explicit sectionCapture: false (default-on is applied at the gate)', () => {
    const cfg = parseSnippetConfig({ apiKey: 'pk_x', sectionCapture: false });
    expect(cfg?.sectionCapture).toBe(false);
  });

  it('coerces an unknown context to landing', () => {
    expect(parseSnippetConfig({ apiKey: 'pk_abc', context: 'blog' })!.context).toBe('landing');
  });

  it('passes through consent, preConsentBehavior, and debug when declared', () => {
    const cfg = parseSnippetConfig({
      apiKey: 'pk_x',
      consent: false,
      preConsentBehavior: 'statistical_winner',
      debug: true,
    })!;
    expect(cfg.consent).toBe(false);
    expect(cfg.preConsentBehavior).toBe('statistical_winner');
    expect(cfg.debug).toBe(true);
  });

  it('omits additive fields when not declared (base shape preserved)', () => {
    const cfg = parseSnippetConfig({ apiKey: 'pk_x' })!;
    expect('consent' in cfg).toBe(false);
    expect('preConsentBehavior' in cfg).toBe(false);
    expect('debug' in cfg).toBe(false);
  });

  it('parses enumerated arms (2–12 strings) and drops invalid arm lists', () => {
    const cfg = parseSnippetConfig({
      apiKey: 'pk_x',
      slots: {
        good: { dims: { tone: ['a', 'b'] }, arms: ['x', 'y', 'z'] },
        badArms: { dims: { tone: ['a', 'b'] }, arms: ['solo'] }, // < 2 arms → dropped, slot kept
      },
    })!;
    expect(cfg.slots.good!.arms).toEqual(['x', 'y', 'z']);
    expect(cfg.slots.badArms!.arms).toBeUndefined();
  });

  it('drops invalid slot declarations, keeps valid ones', () => {
    const cfg = parseSnippetConfig({
      apiKey: 'pk_abc',
      slots: {
        good: { dims: { tone: ['calm', 'urgent'] } },
        oneValue: { dims: { tone: ['calm'] } },              // < 2 values
        noDims: { target: '#x' },                            // dims missing
        badTarget: { dims: { tone: ['a', 'b'] }, target: 7 }, // target not a string
        tooManyDims: { dims: { a: ['1','2'], b: ['1','2'], c: ['1','2'], d: ['1','2'], e: ['1','2'] } }, // > 4 dims
      },
    })!;
    expect(Object.keys(cfg.slots)).toEqual(['good']);
  });
});
