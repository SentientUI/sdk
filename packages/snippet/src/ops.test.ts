import { describe, it, expect, beforeEach } from 'vitest';
import { applyOps, resetOpsSheet } from './ops';

beforeEach(() => {
  document.body.innerHTML = '';
  document.querySelectorAll('style[data-sentient-ops]').forEach((e) => e.remove());
  resetOpsSheet();
});

describe('applyOps', () => {
  it('sets text via textContent, never innerHTML', () => {
    document.body.innerHTML = '<a id="c">old</a>';
    const el = document.getElementById('c')!;
    applyOps(el, { text: '<b>x</b>' }, 'c', document);
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toBe('<b>x</b>');
  });

  it('applies whitelisted style through a generated !important stylesheet', () => {
    document.body.innerHTML = '<a id="c">x</a>';
    applyOps(document.getElementById('c')!, { style: { color: '#0B5', fontWeight: '650' } }, 'hero', document);
    expect(document.getElementById('c')!.getAttribute('data-snt-e')).toBe('hero');
    const sheet = document.querySelector('style[data-sentient-ops]')!;
    expect(sheet.textContent).toContain('[data-snt-e="hero"]');
    expect(sheet.textContent).toContain('color:#0B5 !important');
    expect(sheet.textContent).toContain('font-weight:650 !important');
  });

  it('hides via display:none', () => {
    document.body.innerHTML = '<div id="c"></div>';
    applyOps(document.getElementById('c')!, { hidden: true }, 'hero', document);
    expect(document.querySelector('style[data-sentient-ops]')!.textContent).toContain('display:none !important');
  });

  it('sets https href/src/alt and ignores non-https', () => {
    document.body.innerHTML = '<a id="c"></a>';
    const el = document.getElementById('c')!;
    applyOps(el, { href: 'https://x.com', imageSrc: 'http://insecure', imageAlt: 'A' }, 'c', document);
    expect(el.getAttribute('href')).toBe('https://x.com');
    expect(el.getAttribute('src')).toBeNull();
    expect(el.getAttribute('alt')).toBe('A');
  });

  it('reapply does not duplicate rules for the same slot', () => {
    document.body.innerHTML = '<a id="c">x</a>';
    const el = document.getElementById('c')!;
    applyOps(el, { style: { color: '#111' } }, 'hero', document);
    applyOps(el, { style: { color: '#222' } }, 'hero', document);
    const txt = document.querySelector('style[data-sentient-ops]')!.textContent!;
    expect(txt.match(/data-snt-e="hero"/g)!.length).toBe(1);
    expect(txt).toContain('#222');
  });
});

describe('expanded style props', () => {
  it('emits the new whitelisted properties', () => {
    const el = document.createElement('a');
    document.body.appendChild(el);
    applyOps(el, { style: { width: '320px', boxShadow: '0 2px 8px #00000033', textTransform: 'uppercase' } }, 's1', document);
    const sheet = document.querySelector('style[data-sentient-ops]')!.textContent!;
    expect(sheet).toContain('width:320px !important');
    expect(sheet).toContain('box-shadow:0 2px 8px #00000033 !important');
    expect(sheet).toContain('text-transform:uppercase !important');
  });
  it('still ignores unknown keys', () => {
    const el = document.createElement('a');
    applyOps(el, { style: { position: 'fixed' } as never }, 's1', document);
    expect(document.querySelector('style[data-sentient-ops]')?.textContent ?? '').not.toContain('position');
  });
});

describe('external-resource guard (cssValueSafe)', () => {
  it('drops values that load an external resource via url() / image-set()', () => {
    const el = document.createElement('a');
    document.body.appendChild(el);
    applyOps(el, { style: {
      background: 'url(https://tracker/x.png)',
      border: 'IMAGE-SET("https://tracker/y.png" 1x)',
    } as never }, 's1', document);
    const sheet = document.querySelector('style[data-sentient-ops]')?.textContent ?? '';
    expect(sheet).not.toContain('url(');
    expect(sheet.toLowerCase()).not.toContain('image-set');
    // No rule at all was emitted for this element.
    expect(el.getAttribute('data-snt-e')).toBeNull();
  });

  it('drops an empty-string value (no degenerate `color: !important` rule)', () => {
    // A server-delivered `{color:''}` must not produce a rule at all — the
    // runtime guard rejects empty/whitespace values (previously it did not,
    // diverging from the editor and emitting `color: !important`).
    const el = document.createElement('a');
    document.body.appendChild(el);
    applyOps(el, { style: { color: '', background: '   ' } as never }, 's1', document);
    expect(el.getAttribute('data-snt-e')).toBeNull();
    expect(document.querySelector('style[data-sentient-ops]')).toBeNull();
  });

  it('still allows safe colour/math functions (rgb, hsl, calc)', () => {
    const el = document.createElement('a');
    document.body.appendChild(el);
    applyOps(el, { style: {
      color: 'rgb(10,20,30)', background: 'hsl(200,50%,50%)', width: 'calc(100% - 20px)',
    } }, 's1', document);
    const sheet = document.querySelector('style[data-sentient-ops]')!.textContent!;
    expect(sheet).toContain('color:rgb(10,20,30) !important');
    expect(sheet).toContain('background:hsl(200,50%,50%) !important');
    expect(sheet).toContain('width:calc(100% - 20px) !important');
  });
});

describe('move ops', () => {
  function section(id: string, text: string) {
    const s = document.createElement('section');
    s.id = id; s.textContent = text;
    return s;
  }
  beforeEach(() => { document.body.innerHTML = ''; });

  it('moves the element before the anchor', () => {
    const parent = document.createElement('main');
    const a = section('a', 'A'), b = section('b', 'B'), c = section('c', 'C');
    parent.append(a, b, c); document.body.appendChild(parent);
    const r = applyOps(c, { moveBefore: { v: 1, id: 'a', fingerprint: { tag: 'section', text: 'A' } } }, 's1', document);
    expect(r.anchorMiss).toBe(false);
    expect(Array.from(parent.children).map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });
  it('moves after the anchor and is idempotent on reapply', () => {
    const parent = document.createElement('main');
    const a = section('a', 'A'), b = section('b', 'B');
    parent.append(a, b); document.body.appendChild(parent);
    const ops = { moveAfter: { v: 1, id: 'b', fingerprint: { tag: 'section', text: 'B' } } };
    applyOps(a, ops, 's1', document);
    applyOps(a, ops, 's1', document);
    expect(Array.from(parent.children).map((x) => x.id)).toEqual(['b', 'a']);
  });
  it('reports a miss and applies nothing when the anchor is unresolved, non-sibling, or self', () => {
    const parent = document.createElement('main');
    const a = section('a', 'A'); const other = document.createElement('div'); const d = section('d', 'D');
    other.appendChild(d); parent.append(a); document.body.append(parent, other);
    expect(applyOps(a, { moveBefore: { v: 1, id: 'nope' } }, 's1', document).anchorMiss).toBe(true);
    expect(applyOps(a, { moveBefore: { v: 1, id: 'd', fingerprint: { tag: 'section', text: 'D' } } }, 's1', document).anchorMiss).toBe(true);
    expect(applyOps(a, { moveBefore: { v: 1, id: 'a', fingerprint: { tag: 'section', text: 'A' } } }, 's1', document).anchorMiss).toBe(true);
    expect(Array.from(parent.children).map((x) => x.id)).toEqual(['a']);
  });
});
