import { describe, it, expect, vi } from 'vitest';
import { parseSnippetConfig } from './config';

describe('parseSnippetConfig', () => {
  it('parses a full valid config', () => {
    const cfg = parseSnippetConfig({
      apiKey: 'pk_abc',
      context: 'ecommerce',
      personaAttributes: true,
      slots: { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' } },
    });
    // A legacy `context` key is tolerated but not carried: nothing ever read it.
    expect(cfg).toEqual({
      apiKey: 'pk_abc',
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

  it('defaults personaAttributes to false and slots to {}', () => {
    const cfg = parseSnippetConfig({ apiKey: 'pk_abc' });
    expect(cfg).toEqual({ apiKey: 'pk_abc', personaAttributes: false, slots: {} });
  });

  it('records an explicit sectionCapture: false (default-on is applied at the gate)', () => {
    const cfg = parseSnippetConfig({ apiKey: 'pk_x', sectionCapture: false });
    expect(cfg?.sectionCapture).toBe(false);
  });

  it('still accepts a config carrying the deprecated context key', () => {
    expect(parseSnippetConfig({ apiKey: 'pk_abc', context: 'blog' })).not.toBeNull();
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
        eqValue: { dims: { tone: ['calm', 'a=b'] } },        // '=' is the dims encoding's delimiter
        pipeValue: { dims: { tone: ['calm', 'x|y'] } },      // so is '|'
        eqName: { dims: { 'to=ne': ['a', 'b'] } },
      },
    })!;
    expect(Object.keys(cfg.slots)).toEqual(['good']);
  });
});


describe('declared persona parsing', () => {
  const base = { apiKey: 'pk_x', context: 'saas', slots: {} };

  it('accepts a string persona', () => {
    expect(parseSnippetConfig({ ...base, persona: 'admin' })?.persona).toBe('admin');
  });

  it('evaluates a function persona once at parse time', () => {
    expect(parseSnippetConfig({ ...base, persona: () => 'evaluator' })?.persona).toBe('evaluator');
  });

  it('a throwing or non-string getter is a missing declaration, never an error', () => {
    expect(parseSnippetConfig({ ...base, persona: () => { throw new Error('boom'); } })?.persona).toBeUndefined();
    expect(parseSnippetConfig({ ...base, persona: () => 42 })?.persona).toBeUndefined();
    expect(parseSnippetConfig({ ...base, persona: 7 })?.persona).toBeUndefined();
    expect(parseSnippetConfig({ ...base, persona: '   ' })?.persona).toBeUndefined();
  });
});

describe('sections parsing (B1.1)', () => {
  const base = { apiKey: 'pk_x', context: 'landing', slots: {} };

  it('accepts an ordered selector list', () => {
    expect(parseSnippetConfig({ ...base, sections: ['#hero', '#pricing', '#faq'] })?.sections)
      .toEqual(['#hero', '#pricing', '#faq']);
  });

  it('drops non-strings and empties; fewer than two survivors is undeclared', () => {
    expect(parseSnippetConfig({ ...base, sections: ['#hero', 42, '', '  ', '#faq'] })?.sections)
      .toEqual(['#hero', '#faq']);
    expect(parseSnippetConfig({ ...base, sections: ['#hero', null, ''] })?.sections).toBeUndefined();
    expect(parseSnippetConfig({ ...base, sections: 'x' })?.sections).toBeUndefined();
  });

  it('caps at 50 so an oversized list degrades instead of 400ing the decide', () => {
    const many = Array.from({ length: 60 }, (_, i) => `#s${i}`);
    expect(parseSnippetConfig({ ...base, sections: many })?.sections).toHaveLength(50);
  });
});

describe('consentFrom', () => {
  it('accepts presets and option objects, drops anything else', () => {
    expect(parseSnippetConfig({ apiKey: 'pk_test', consentFrom: 'onetrust' })?.consentFrom).toBe('onetrust');
    expect(parseSnippetConfig({ apiKey: 'pk_test', consentFrom: { cmp: 'tcf', purposes: [1, 8] } })?.consentFrom).toEqual({ cmp: 'tcf', purposes: [1, 8] });
    expect(parseSnippetConfig({ apiKey: 'pk_test', consentFrom: { cookie: 'c', value: 'y' } })?.consentFrom).toEqual({ cookie: 'c', value: 'y' });
    expect(parseSnippetConfig({ apiKey: 'pk_test', consentFrom: 'trustme' })?.consentFrom).toBeUndefined();
    expect(parseSnippetConfig({ apiKey: 'pk_test', consentFrom: { cmp: 'nope' } })?.consentFrom).toBeUndefined();
  });

  it('an unusable consent config fails CLOSED, with a warning (audit N4)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const bad of [
      { consentFrom: 'onetrsut' },
      { consentFrom: { cmp: 'Cookiebot' } },
      { consentFrom: { event: 'x' } },
      { consentFrom: 42 },
      { consent: 'false' },
    ]) {
      expect(parseSnippetConfig({ apiKey: 'pk_test', ...bad })?.consent, JSON.stringify(bad)).toBe(false);
    }
    expect(warn).toHaveBeenCalledTimes(5);
    expect(parseSnippetConfig({ apiKey: 'pk_test' })?.consent).toBeUndefined();
    warn.mockRestore();
  });
});
