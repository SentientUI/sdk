import { describe, it, expect, beforeEach } from 'vitest';
import { applyPersonaAttributes, applySlotAttributes, applySlotArms, applyRegistrySlots } from './apply';
import { resetOpsSheet } from './ops';

beforeEach(() => {
  document.documentElement.removeAttribute('data-sentient-persona');
  document.documentElement.removeAttribute('data-sentient-confidence');
  document.documentElement.removeAttribute('data-tone');
  document.body.innerHTML = '';
});

describe('applyPersonaAttributes', () => {
  it('sets persona and confidence on <html>', () => {
    applyPersonaAttributes('deal_seeker', 'high', document);
    expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('deal_seeker');
    expect(document.documentElement.getAttribute('data-sentient-confidence')).toBe('high');
  });
});

describe('applySlotAttributes', () => {
  it('sets data-<dim> attributes on all elements matching the target selector', () => {
    document.body.innerHTML = '<section class="hero"></section><section class="hero"></section>';
    applySlotAttributes(
      { hero: { tone: 'urgent', motion: 'none' } },
      { hero: { dims: { tone: ['calm', 'urgent'], motion: ['none', 'pulse'] }, target: '.hero' } },
      document,
    );
    for (const el of Array.from(document.querySelectorAll('.hero'))) {
      expect(el.getAttribute('data-tone')).toBe('urgent');
      expect(el.getAttribute('data-motion')).toBe('none');
    }
  });

  it('defaults the target to document.documentElement', () => {
    applySlotAttributes(
      { hero: { tone: 'calm' } },
      { hero: { dims: { tone: ['calm', 'urgent'] } } },
      document,
    );
    expect(document.documentElement.getAttribute('data-tone')).toBe('calm');
  });

  it('ignores string (enumerated-arm) results — Style rung applies dims only', () => {
    applySlotAttributes(
      { hero: 'variant_b' },
      { hero: { dims: { tone: ['calm', 'urgent'] } } },
      document,
    );
    expect(document.documentElement.getAttribute('data-tone')).toBeNull();
  });

  it('never writes a dim or value outside the declared space', () => {
    document.body.innerHTML = '<div id="t"></div>';
    applySlotAttributes(
      { hero: { tone: 'shouty', evil: 'yes' } },
      { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#t' } },
      document,
    );
    const el = document.getElementById('t')!;
    expect(el.getAttribute('data-tone')).toBeNull();
    expect(el.getAttribute('data-evil')).toBeNull();
  });

  it('skips slots that have no result and results that have no declaration', () => {
    document.body.innerHTML = '<div id="t"></div>';
    applySlotAttributes(
      { other: { tone: 'calm' } },
      { hero: { dims: { tone: ['calm', 'urgent'] }, target: '#t' } },
      document,
    );
    expect(document.getElementById('t')!.getAttribute('data-tone')).toBeNull();
  });
});

describe('applySlotArms (Safe Swap rung)', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-sentient-arm');
    document.body.innerHTML = '';
  });

  it('writes data-sentient-arm for a declared enumerated arm', () => {
    document.body.innerHTML = '<div id="t"></div>';
    applySlotArms(
      { hero: 'variant_b' },
      { hero: { dims: { tone: ['a', 'b'] }, target: '#t', arms: ['variant_a', 'variant_b'] } },
      document,
    );
    expect(document.getElementById('t')!.getAttribute('data-sentient-arm')).toBe('variant_b');
  });

  it('never writes an arm outside the declared arms list', () => {
    document.body.innerHTML = '<div id="t"></div>';
    applySlotArms(
      { hero: 'variant_z' },
      { hero: { dims: { tone: ['a', 'b'] }, target: '#t', arms: ['variant_a', 'variant_b'] } },
      document,
    );
    expect(document.getElementById('t')!.getAttribute('data-sentient-arm')).toBeNull();
  });

  it('ignores dims (object) results — those are the Style rung', () => {
    applySlotArms(
      { hero: { tone: 'a' } },
      { hero: { dims: { tone: ['a', 'b'] }, arms: ['x', 'y'] } },
      document,
    );
    expect(document.documentElement.getAttribute('data-sentient-arm')).toBeNull();
  });
});

describe('applyRegistrySlots (registry mode — server-owned config)', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-sentient-arm');
    document.documentElement.removeAttribute('data-tone');
    document.body.innerHTML = '';
    document.querySelectorAll('style[data-sentient-ops]').forEach((e) => e.remove());
    resetOpsSheet();
  });

  it('applies a dims result as data-<dim> on the config target', () => {
    document.body.innerHTML = '<div id="hero"></div>';
    applyRegistrySlots(
      { hero: { tone: 'urgent' } },
      { hero: { kind: 'tokens', target: '#hero' } },
      document,
    );
    expect(document.getElementById('hero')!.getAttribute('data-tone')).toBe('urgent');
  });

  it('applies an arm result as data-sentient-arm and sets content via textContent', () => {
    document.body.innerHTML = '<a id="cta">old</a>';
    applyRegistrySlots(
      { cta: 'urgent' },
      { cta: { kind: 'arms', target: '#cta', content: 'Book a demo' } },
      document,
    );
    const el = document.getElementById('cta')!;
    expect(el.getAttribute('data-sentient-arm')).toBe('urgent');
    expect(el.textContent).toBe('Book a demo');
  });

  it('never uses innerHTML — content with markup lands as literal text', () => {
    document.body.innerHTML = '<a id="cta"></a>';
    applyRegistrySlots(
      { cta: 'x' },
      { cta: { kind: 'arms', target: '#cta', content: '<img src=x onerror=alert(1)>' } },
      document,
    );
    const el = document.getElementById('cta')!;
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('defaults the target to <html> when none is given', () => {
    applyRegistrySlots({ hero: 'urgent' }, { hero: { kind: 'arms' } }, document);
    expect(document.documentElement.getAttribute('data-sentient-arm')).toBe('urgent');
  });

  it('skips a config entry with no matching result', () => {
    document.body.innerHTML = '<div id="hero"></div>';
    applyRegistrySlots({}, { hero: { kind: 'tokens', target: '#hero' } }, document);
    expect(document.getElementById('hero')!.getAttribute('data-tone')).toBeNull();
  });

  it('resolves a compound locator and applies the arm + bounded ops', () => {
    document.body.innerHTML = '<a id="cta">old</a>';
    applyRegistrySlots(
      { hero: 'urgent' },
      { hero: { kind: 'arms', locator: { id: 'cta' }, ops: { text: 'Book now', style: { color: '#0B5' } } } },
      document,
    );
    const el = document.getElementById('cta')!;
    expect(el.getAttribute('data-sentient-arm')).toBe('urgent');
    expect(el.textContent).toBe('Book now');
    expect(document.querySelector('style[data-sentient-ops]')!.textContent).toContain('color:#0B5 !important');
  });

  it('applies nothing and reports a miss when the compound locator is ambiguous', () => {
    document.body.innerHTML = '<a class="x"></a><a class="x"></a>';
    const missed = applyRegistrySlots({ hero: 'urgent' }, { hero: { kind: 'arms', locator: { selector: '.x' } } }, document);
    expect(document.querySelector('[data-sentient-arm]')).toBeNull();
    expect(missed).toEqual(['hero']);
  });

  it('reports no miss when the target resolves', () => {
    document.body.innerHTML = '<a id="hero"></a>';
    const missed = applyRegistrySlots({ hero: 'urgent' }, { hero: { kind: 'arms', locator: { id: 'hero' } } }, document);
    expect(missed).toEqual([]);
  });

  it('skips a URL-scoped-out slot entirely — never a false-positive miss', () => {
    // jsdom pathname is '/'; a slot scoped to '/pricing' is intentionally absent
    // here and must NOT be reported as a broken-locator miss.
    document.body.innerHTML = '<a id="cta"></a>';
    const missed = applyRegistrySlots(
      { cta: 'urgent' },
      { cta: { kind: 'arms', locator: { id: 'cta', urlMatch: '/pricing' } } },
      document,
    );
    expect(missed).toEqual([]);
    expect(document.getElementById('cta')!.getAttribute('data-sentient-arm')).toBeNull();
  });

  it('pre-paint (contentAndOps:false) applies attributes but withholds content + ops', () => {
    document.body.innerHTML = '<a id="cta">original</a>';
    applyRegistrySlots(
      { cta: 'urgent' },
      { cta: { kind: 'arms', locator: { id: 'cta' }, content: 'Book a demo', ops: { text: 'Book now', style: { color: '#0B5' } } } },
      document,
      { contentAndOps: false },
    );
    const el = document.getElementById('cta')!;
    // Reversible attribute is applied…
    expect(el.getAttribute('data-sentient-arm')).toBe('urgent');
    // …but the possibly-stale copy/ops are NOT painted before decide confirms.
    expect(el.textContent).toBe('original');
    expect(document.querySelector('style[data-sentient-ops]')).toBeNull();
  });

  it('adds anchor-missing slots to the missed array; pre-paint never moves', () => {
    document.body.innerHTML = '<main><section id="a">A</section><section id="b">B</section></main>';
    const cfg = { s1: { kind: 'arms' as const, locator: { v: 1, id: 'b', fingerprint: { tag: 'section', text: 'B' } }, ops: { moveBefore: { v: 1, id: 'gone' } } } };
    const missed = applyRegistrySlots({ s1: 'b' }, cfg, document);
    expect(missed).toContain('s1');
    document.body.innerHTML = '<main><section id="a">A</section><section id="b">B</section></main>';
    const cfg2 = { s1: { kind: 'arms' as const, locator: { v: 1, id: 'b', fingerprint: { tag: 'section', text: 'B' } }, ops: { moveBefore: { v: 1, id: 'a', fingerprint: { tag: 'section', text: 'A' } } } } };
    applyRegistrySlots({ s1: 'b' }, cfg2, document, { contentAndOps: false });
    expect(Array.from(document.querySelector('main')!.children).map((x) => x.id)).toEqual(['a', 'b']); // unmoved
  });
});

describe('applyRegistrySlots onApplied (per-option behavior signals)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetOpsSheet();
  });

  it('fires onApplied with (slotId, arm, el) for a string result on the post-decide pass', () => {
    document.body.innerHTML = '<a id="cta">old</a>';
    const applied: Array<[string, string, Element]> = [];
    applyRegistrySlots(
      { cta: 'urgent' },
      { cta: { kind: 'arms', target: '#cta', content: 'Book a demo' } },
      document,
      { onApplied: (slotId, arm, el) => applied.push([slotId, arm, el]) },
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]![0]).toBe('cta');
    expect(applied[0]![1]).toBe('urgent');
    expect((applied[0]![2] as HTMLElement).id).toBe('cta');
  });

  it('does not fire on the pre-paint pass or for dims results', () => {
    document.body.innerHTML = '<a id="cta">old</a><div id="hero"></div>';
    const applied: string[] = [];
    applyRegistrySlots(
      { cta: 'urgent' },
      { cta: { kind: 'arms', target: '#cta' } },
      document,
      { contentAndOps: false, onApplied: (slotId) => applied.push(slotId) },
    );
    applyRegistrySlots(
      { hero: { tone: 'urgent' } },
      { hero: { kind: 'tokens', target: '#hero' } },
      document,
      { onApplied: (slotId) => applied.push(slotId) },
    );
    expect(applied).toEqual([]);
  });
});
