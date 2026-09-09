import { describe, it, expect, beforeEach } from 'vitest';
import { planReorder } from './layout-order';
import { renderSnippetPrePaintScript } from './prepaint-script';

// The reorder exists twice: once as planReorder() (called by the bundle) and
// once hand-minified inside the inline pre-paint script, which must run with
// zero bytes downloaded. This file is the contract between them — every case
// below is asserted against BOTH, so a drift is a red test rather than a wrong
// page.

type Case = {
  name: string;
  /** Markup for a shared parent. Each child gets an id so selectors are '#id'. */
  ids: string[];
  /** The served order, as selectors. */
  order: string[];
  /** The selectors the site declared in `sections` (defaults to `order`). */
  sections?: string[];
  /** Expected DOM id order after applying, or 'unchanged'. */
  expected: string[] | 'unchanged';
};

const CASES: Case[] = [
  {
    name: 'moves the last section to the front',
    ids: ['hero', 'plans', 'faq'],
    order: ['#faq', '#hero', '#plans'],
    expected: ['faq', 'hero', 'plans'],
  },
  {
    name: 'swaps a middle pair',
    ids: ['a', 'b', 'c', 'd'],
    order: ['#a', '#c', '#b', '#d'],
    expected: ['a', 'c', 'b', 'd'],
  },
  {
    name: 'reverses',
    ids: ['a', 'b', 'c'],
    order: ['#c', '#b', '#a'],
    expected: ['c', 'b', 'a'],
  },
  {
    name: 'is a no-op when the DOM is already in the served order (idempotent)',
    ids: ['a', 'b', 'c'],
    order: ['#a', '#b', '#c'],
    expected: 'unchanged',
  },
  {
    name: 'applies nothing when a section is missing from the page',
    ids: ['a', 'b'],
    order: ['#a', '#b', '#c'],
    sections: ['#a', '#b', '#c'],
    expected: 'unchanged',
  },
  {
    name: 'applies nothing when the served order names something not declared',
    ids: ['a', 'b', 'c'],
    order: ['#a', '#b', '#zzz'],
    sections: ['#a', '#b', '#c'],
    expected: 'unchanged',
  },
  {
    name: 'applies nothing for a single-element order',
    ids: ['a', 'b'],
    order: ['#a'],
    sections: ['#a'],
    expected: 'unchanged',
  },
  {
    name: 'applies nothing when the order repeats an id',
    ids: ['a', 'b'],
    order: ['#a', '#a'],
    sections: ['#a', '#b'],
    expected: 'unchanged',
  },
  {
    name: 'applies nothing when two selectors resolve to the SAME element',
    ids: ['a', 'b'],
    order: ['#a', '[id="a"]'],
    sections: ['#a', '[id="a"]'],
    expected: 'unchanged',
  },
  {
    name: 'applies nothing when an ambiguous selector matches two elements',
    ids: ['a', 'b', 'c'],
    order: ['.sec', '#a', '#b'],
    sections: ['.sec', '#a', '#b'],
    expected: 'unchanged',
  },
  {
    name: 'applies nothing for an invalid selector',
    ids: ['a', 'b'],
    order: ['#a', ':::nope'],
    sections: ['#a', ':::nope'],
    expected: 'unchanged',
  },
];

function build(ids: string[]): HTMLElement {
  const parent = document.createElement('main');
  for (const id of ids) {
    const el = document.createElement('section');
    el.id = id;
    // Two elements carry .sec so the ambiguity case has something to hit.
    if (id === 'a' || id === 'b') el.className = 'sec';
    parent.appendChild(el);
  }
  document.body.appendChild(parent);
  return parent;
}

function idsOf(parent: Element): string[] {
  return Array.from(parent.children).map((el) => el.id);
}

/** What the bundle does: resolveSections + planReorder + insertBefore. */
function applyViaPlanReorder(c: Case): void {
  const resolved = new Map<string, Element>();
  for (const sel of c.sections ?? c.order) {
    try {
      const els = document.querySelectorAll(sel);
      if (els.length === 1) resolved.set(sel, els[0]!);
    } catch {
      /* invalid selector — dropped, same as resolveSections */
    }
  }
  for (const m of planReorder(c.order, resolved) ?? []) {
    m.before.parentNode?.insertBefore(m.el, m.before);
  }
}

/** What the inline script does: config + snapshot, then evaluate the script. */
function applyViaInlineScript(c: Case): void {
  (window as unknown as { sentient?: unknown }).sentient = {
    apiKey: 'pk_test',
    sections: c.sections ?? c.order,
  };
  localStorage.setItem(
    '_snt_snap:pk_test',
    JSON.stringify({
      v: 1,
      persona: 'buyer',
      band: 'high',
      slots: {},
      layoutOrder: c.order,
      savedAt: Date.now(),
    }),
  );
  (0, eval)(renderSnippetPrePaintScript());
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  delete (window as unknown as { sentient?: unknown }).sentient;
  delete (window as unknown as { __sntPP?: unknown }).__sntPP;
});

describe('planReorder / inline copy — one behaviour, two implementations', () => {
  for (const c of CASES) {
    it(`${c.name} (bundle)`, () => {
      const parent = build(c.ids);
      applyViaPlanReorder(c);
      expect(idsOf(parent)).toEqual(c.expected === 'unchanged' ? c.ids : c.expected);
    });

    it(`${c.name} (inline)`, () => {
      const parent = build(c.ids);
      applyViaInlineScript(c);
      expect(idsOf(parent)).toEqual(c.expected === 'unchanged' ? c.ids : c.expected);
    });
  }
});

describe('planReorder', () => {
  it('returns null when the sections do not share one parent', () => {
    document.body.innerHTML =
      '<main><section id="a"></section></main><aside><section id="b"></section></aside>';
    const resolved = new Map<string, Element>([
      ['#a', document.querySelector('#a')!],
      ['#b', document.querySelector('#b')!],
    ]);
    expect(planReorder(['#b', '#a'], resolved)).toBeNull();
  });

  it('returns null for a null/short order without touching resolved', () => {
    expect(planReorder(null, new Map())).toBeNull();
    expect(planReorder(['#a'], new Map())).toBeNull();
  });
});
