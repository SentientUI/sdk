import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderSnippetPrePaintScript, SNIPPET_PREPAINT_VERSION, type PrePaintRecord } from './prepaint-script';

const KEY = 'pk_test_abc';
const SNAP_KEY = `_snt_snap:${KEY}`;

type Snap = Record<string, unknown>;

function snapshot(over: Snap = {}): Snap {
  return {
    v: 1,
    persona: 'trial_user',
    band: 'high',
    slots: {},
    layoutOrder: null,
    savedAt: Date.now(),
    ...over,
  };
}

function seed(cfg: Record<string, unknown> | undefined, snap: Snap | string | null): void {
  if (cfg) (window as unknown as { sentient?: unknown }).sentient = cfg;
  if (snap !== null) {
    localStorage.setItem(SNAP_KEY, typeof snap === 'string' ? snap : JSON.stringify(snap));
  }
}

/** Run the inline script exactly as an inline <script> in <head> would. */
function run(): void {
  (0, eval)(renderSnippetPrePaintScript());
}

function pp(): PrePaintRecord | undefined {
  return (window as unknown as { __sntPP?: PrePaintRecord }).__sntPP;
}

/**
 * Insert a node the way the parser does — into the live document, under an
 * observer that is already running — then let the MutationObserver callback
 * fire. jsdom delivers observer records on a microtask, same as a browser.
 */
async function parse(html: string, into: Element = document.body): Promise<void> {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  while (tmp.firstChild) into.appendChild(tmp.firstChild);
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-sentient-persona');
  document.documentElement.removeAttribute('data-sentient-confidence');
  delete (window as unknown as { sentient?: unknown }).sentient;
  delete (window as unknown as { __sntPP?: unknown }).__sntPP;
  history.replaceState(null, '', '/');
});

afterEach(() => {
  pp()?.stop?.();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('renderSnippetPrePaintScript — string safety', () => {
  it('is a constant with no interpolation surface', () => {
    expect(renderSnippetPrePaintScript()).toBe(renderSnippetPrePaintScript());
  });

  it('cannot terminate the inline <script> and survives template-literal renderers', () => {
    const s = renderSnippetPrePaintScript();
    expect(s).not.toContain('<'); // stricter than "no </": no `<` at all
    expect(s).not.toContain('`');
    expect(() => new Function(s)).not.toThrow();
  });

  it('pins the contract version', () => {
    expect(SNIPPET_PREPAINT_VERSION).toBe(2);
  });
});

describe('gates — each one produces no __sntPP and no attributes', () => {
  const cases: Array<[string, () => void]> = [
    ['no window.sentient at all', () => seed(undefined, snapshot())],
    ['no apiKey', () => seed({ personaAttributes: true }, snapshot())],
    ['consent: false', () => seed({ apiKey: KEY, consent: false, personaAttributes: true }, snapshot())],
    ['no snapshot', () => seed({ apiKey: KEY, personaAttributes: true }, null)],
    ['corrupt snapshot', () => seed({ apiKey: KEY, personaAttributes: true }, '{broken')],
    ['wrong snapshot version', () => seed({ apiKey: KEY, personaAttributes: true }, snapshot({ v: 2 }))],
    ['non-string persona', () => seed({ apiKey: KEY, personaAttributes: true }, snapshot({ persona: 42 }))],
    ['slots is not an object', () => seed({ apiKey: KEY, personaAttributes: true }, snapshot({ slots: 'nope' }))],
    ['missing savedAt', () => seed({ apiKey: KEY, personaAttributes: true }, snapshot({ savedAt: undefined }))],
    [
      'snapshot older than the 30-day visitor window',
      () => seed({ apiKey: KEY, personaAttributes: true }, snapshot({ savedAt: Date.now() - 31 * 86400_000 })),
    ],
  ];

  for (const [name, setup] of cases) {
    it(name, () => {
      setup();
      run();
      expect(pp()).toBeUndefined();
      expect(document.documentElement.hasAttribute('data-sentient-persona')).toBe(false);
    });
  }

  it('Do-Not-Track', () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    try {
      seed({ apiKey: KEY, personaAttributes: true }, snapshot());
      run();
      expect(pp()).toBeUndefined();
    } finally {
      Reflect.deleteProperty(navigator, 'doNotTrack');
    }
  });

  it('Global Privacy Control', () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    try {
      seed({ apiKey: KEY, personaAttributes: true }, snapshot());
      run();
      expect(pp()).toBeUndefined();
    } finally {
      Reflect.deleteProperty(navigator, 'globalPrivacyControl');
    }
  });

  it('automation (navigator.webdriver)', () => {
    Object.defineProperty(navigator, 'webdriver', { value: true, configurable: true });
    try {
      seed({ apiKey: KEY, personaAttributes: true }, snapshot());
      run();
      expect(pp()).toBeUndefined();
    } finally {
      Reflect.deleteProperty(navigator, 'webdriver');
    }
  });

  for (const param of ['sentient_editor=tok', 'sentient_preview=hero:urgent', 'sentient_persona=admin']) {
    it(`?${param}`, () => {
      history.replaceState(null, '', `/?${param}`);
      seed({ apiKey: KEY, personaAttributes: true }, snapshot());
      run();
      expect(pp()).toBeUndefined();
      expect(document.documentElement.hasAttribute('data-sentient-persona')).toBe(false);
    });
  }

  it('does not run twice (double-embed guard)', () => {
    seed({ apiKey: KEY, personaAttributes: true }, snapshot());
    run();
    const first = pp();
    run();
    expect(pp()).toBe(first);
    expect(first!.html).toEqual(['data-sentient-persona', 'data-sentient-confidence']);
  });
});

describe('persona attributes', () => {
  it('stamps <html> when personaAttributes is on, and records what it set', () => {
    seed({ apiKey: KEY, personaAttributes: true }, snapshot());
    run();
    expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('trial_user');
    expect(document.documentElement.getAttribute('data-sentient-confidence')).toBe('high');
    expect(pp()!.html).toEqual(['data-sentient-persona', 'data-sentient-confidence']);
  });

  it('leaves <html> alone when personaAttributes is off', () => {
    seed({ apiKey: KEY }, snapshot());
    run();
    expect(document.documentElement.hasAttribute('data-sentient-persona')).toBe(false);
    expect(pp()!.html).toEqual([]);
  });

  it('never overwrites an attribute an SSR pass already set (single writer)', () => {
    document.documentElement.setAttribute('data-sentient-persona', 'evaluator');
    seed({ apiKey: KEY, personaAttributes: true }, snapshot());
    run();
    expect(document.documentElement.getAttribute('data-sentient-persona')).toBe('evaluator');
    expect(pp()!.html).toEqual([]);
  });
});

describe('declared slots — stamped as the parser inserts them', () => {
  it('stamps dims and arms once the target appears', async () => {
    seed(
      {
        apiKey: KEY,
        slots: {
          hero: { dims: { tone: ['calm', 'urgent'] }, target: '#hero' },
          cta: { dims: { x: ['a'] }, arms: ['plain', 'bold'], target: '#cta' },
        },
      },
      snapshot({ slots: { hero: { tone: 'urgent' }, cta: 'bold' } }),
    );
    run();
    // Nothing exists yet — the head script ran before the body parsed.
    expect(pp()!.stamped).toEqual([]);

    await parse('<div id="hero"></div><div id="cta"></div>');

    expect(document.querySelector('#hero')!.getAttribute('data-tone')).toBe('urgent');
    expect(document.querySelector('#cta')!.getAttribute('data-sentient-arm')).toBe('bold');
    expect(pp()!.stamped).toHaveLength(2);
    // The prior value is recorded so the bundle can put it back.
    expect(pp()!.stamped[0]![2]).toBeNull();
  });

  it('never writes a value outside the declared space', async () => {
    seed(
      { apiKey: KEY, slots: { hero: { dims: { tone: ['calm'] }, arms: ['plain'], target: '#hero' } } },
      snapshot({ slots: { hero: { tone: 'urgent' } } }),
    );
    run();
    await parse('<div id="hero"></div>');
    expect(document.querySelector('#hero')!.hasAttribute('data-tone')).toBe(false);
    expect(pp()!.stamped).toEqual([]);
  });

  it('unstamps and retires a selector that becomes ambiguous mid-parse', async () => {
    seed(
      { apiKey: KEY, slots: { hero: { dims: { tone: ['urgent'] }, target: '.hero' } } },
      snapshot({ slots: { hero: { tone: 'urgent' } } }),
    );
    run();
    await parse('<div class="hero"></div>');
    expect(document.querySelector('.hero')!.getAttribute('data-tone')).toBe('urgent');

    // A second match arrives later in the stream: ambiguous, so the guess is
    // withdrawn and the bundle's authoritative pass decides.
    await parse('<div class="hero"></div>');
    for (const el of Array.from(document.querySelectorAll('.hero'))) {
      expect(el.hasAttribute('data-tone')).toBe(false);
    }
    expect(pp()!.stamped).toEqual([]);
  });

  it('restores the merchant’s own prior value in the unstamp path', async () => {
    seed(
      { apiKey: KEY, slots: { hero: { dims: { tone: ['urgent'] }, target: '.hero' } } },
      snapshot({ slots: { hero: { tone: 'urgent' } } }),
    );
    run();
    await parse('<div class="hero" data-tone="calm"></div>');
    expect(document.querySelector('.hero')!.getAttribute('data-tone')).toBe('urgent');
    await parse('<div class="hero"></div>');
    expect(document.querySelector('.hero')!.getAttribute('data-tone')).toBe('calm');
  });

  it('skips an invalid selector without breaking the other slots', async () => {
    seed(
      {
        apiKey: KEY,
        slots: {
          bad: { dims: { tone: ['urgent'] }, target: ':::nope' },
          hero: { dims: { tone: ['urgent'] }, target: '#hero' },
        },
      },
      snapshot({ slots: { bad: { tone: 'urgent' }, hero: { tone: 'urgent' } } }),
    );
    run();
    await parse('<div id="hero"></div>');
    expect(document.querySelector('#hero')!.getAttribute('data-tone')).toBe('urgent');
  });
});

describe('registry slots — structural locator parts only', () => {
  it('resolves an id locator', async () => {
    seed(
      { apiKey: KEY },
      snapshot({
        slots: { headline: 'social_first' },
        slotConfig: { headline: { kind: 'arms', locator: { id: 'headline', fingerprint: { tag: 'h1', text: 'Anything' } } } },
      }),
    );
    run();
    // The fingerprint is deliberately NOT checked here — it cannot be, before
    // the element's children parse. The bundle verifies it and reverts.
    await parse('<h1 id="headline">Something else</h1>');
    expect(document.querySelector('#headline')!.getAttribute('data-sentient-arm')).toBe('social_first');
  });

  it('resolves a dataAttr locator, escaping the value', async () => {
    seed(
      { apiKey: KEY },
      snapshot({
        slots: { hero: 'bold' },
        slotConfig: { hero: { kind: 'arms', locator: { dataAttr: { name: 'data-framer-name', value: 'He"ro' } } } },
      }),
    );
    run();
    await parse('<div data-framer-name=\'He"ro\'></div>');
    expect(document.querySelector('[data-framer-name]')!.getAttribute('data-sentient-arm')).toBe('bold');
  });

  it('falls back to the bare target selector when there is no locator', async () => {
    seed(
      { apiKey: KEY },
      snapshot({ slots: { hero: 'bold' }, slotConfig: { hero: { kind: 'arms', target: '#hero' } } }),
    );
    run();
    await parse('<div id="hero"></div>');
    expect(document.querySelector('#hero')!.getAttribute('data-sentient-arm')).toBe('bold');
  });

  it('honours urlMatch — a slot scoped to another path applies nothing', async () => {
    history.replaceState(null, '', '/about');
    seed(
      { apiKey: KEY },
      snapshot({
        slots: { hero: 'bold' },
        slotConfig: { hero: { kind: 'arms', locator: { id: 'hero', urlMatch: '/pricing' } } },
      }),
    );
    run();
    await parse('<div id="hero"></div>');
    expect(document.querySelector('#hero')!.hasAttribute('data-sentient-arm')).toBe(false);
    expect(pp()!.stamped).toEqual([]);
  });

  it('applies no content and no ops, ever', async () => {
    seed(
      { apiKey: KEY },
      snapshot({
        slots: { hero: 'bold' },
        slotConfig: {
          hero: { kind: 'arms', target: '#hero', content: 'REPLACED', ops: { text: 'ALSO REPLACED', hidden: true } },
        },
      }),
    );
    run();
    await parse('<div id="hero">Original</div>');
    const el = document.querySelector('#hero')!;
    expect(el.textContent).toBe('Original');
    expect(el.getAttribute('data-sentient-arm')).toBe('bold');
  });
});

describe('section reorder', () => {
  it('fires only once every selector resolves, and never partially', async () => {
    seed(
      { apiKey: KEY, sections: ['#a', '#b', '#c'] },
      snapshot({ layoutOrder: ['#c', '#a', '#b'] }),
    );
    run();
    const main = document.createElement('main');
    document.body.appendChild(main);

    await parse('<section id="a"></section><section id="b"></section>', main);
    // Only two of three sections exist — nothing may move yet.
    expect(Array.from(main.children).map((el) => el.id)).toEqual(['a', 'b']);
    expect(pp()!.reordered).toBe(false);

    await parse('<section id="c"></section>', main);
    expect(Array.from(main.children).map((el) => el.id)).toEqual(['c', 'a', 'b']);
    expect(pp()!.reordered).toBe(true);
  });

  it('does nothing when the served order is not a permutation of the sections', async () => {
    seed({ apiKey: KEY, sections: ['#a', '#b'] }, snapshot({ layoutOrder: ['#b', '#zzz'] }));
    run();
    const main = document.createElement('main');
    document.body.appendChild(main);
    await parse('<section id="a"></section><section id="b"></section>', main);
    expect(Array.from(main.children).map((el) => el.id)).toEqual(['a', 'b']);
    expect(pp()!.reordered).toBe(false);
  });

  it('does nothing without a cached order', async () => {
    seed({ apiKey: KEY, sections: ['#a', '#b'] }, snapshot({ layoutOrder: null }));
    run();
    const main = document.createElement('main');
    document.body.appendChild(main);
    await parse('<section id="b"></section><section id="a"></section>', main);
    expect(Array.from(main.children).map((el) => el.id)).toEqual(['b', 'a']);
  });
});

describe('v2 QA gates', () => {
  afterEach(() => sessionStorage.clear());

  for (const url of ['/?sentient_context=cart_recovery', '/#sentient_editor_code=abc', '/?x=1#sentient_preview_token=t.s']) {
    it(`${url}`, () => {
      history.replaceState(null, '', url);
      seed({ apiKey: KEY, personaAttributes: true }, snapshot());
      run();
      expect(pp()).toBeUndefined();
      expect(document.documentElement.hasAttribute('data-sentient-persona')).toBe(false);
    });
  }

  it('a cached editor session (no URL marker at all)', () => {
    sessionStorage.setItem('__snt_editor_token', 'tok');
    seed({ apiKey: KEY, personaAttributes: true }, snapshot());
    run();
    expect(pp()).toBeUndefined();
  });
});

describe('stage attribute (v2, opt-in stageAttributes)', () => {
  afterEach(() => document.documentElement.removeAttribute('data-sentient-stage'));
  const stage = () => document.documentElement.getAttribute('data-sentient-stage');

  it('copies the snapshot stage and records it for the reconcile', () => {
    seed({ apiKey: KEY, stageAttributes: true }, snapshot({ stage: 'carted' }));
    run();
    expect(stage()).toBe('carted');
    expect(pp()!.html).toEqual(['data-sentient-stage']);
  });

  it("coarsens customer/lapsed unless the site asked for 'detailed'", () => {
    seed({ apiKey: KEY, stageAttributes: true }, snapshot({ stage: 'lapsed' }));
    run();
    expect(stage()).toBe('returning');
    pp()!.stop();
    delete (window as unknown as { __sntPP?: unknown }).__sntPP;
    document.documentElement.removeAttribute('data-sentient-stage');
    seed({ apiKey: KEY, stageAttributes: 'detailed' }, snapshot({ stage: 'lapsed' }));
    run();
    expect(stage()).toBe('lapsed');
  });

  it('writes nothing without the opt-in, without a stored stage, or over a server-written one', () => {
    seed({ apiKey: KEY }, snapshot({ stage: 'carted' }));
    run();
    expect(stage()).toBeNull();
    pp()!.stop();
    delete (window as unknown as { __sntPP?: unknown }).__sntPP;
    seed({ apiKey: KEY, stageAttributes: true }, snapshot());
    run();
    expect(stage()).toBeNull();
    pp()!.stop();
    delete (window as unknown as { __sntPP?: unknown }).__sntPP;
    document.documentElement.setAttribute('data-sentient-stage', 'new');
    seed({ apiKey: KEY, stageAttributes: true }, snapshot({ stage: 'carted' }));
    run();
    expect(stage()).toBe('new');
    expect(pp()!.html).toEqual([]);
  });

  it('sets persona and stage together', () => {
    seed({ apiKey: KEY, personaAttributes: true, stageAttributes: true }, snapshot({ stage: 'new' }));
    run();
    expect(pp()!.html).toEqual(['data-sentient-persona', 'data-sentient-confidence', 'data-sentient-stage']);
  });
});

describe('strong-intent hold (v2)', () => {
  // A registry slot the visitor's snapshot knows about, plus a page-declared
  // one (attribute rung) the hold must never touch.
  const registrySnap = () =>
    snapshot({
      slots: { headline: 'cart_v1', decl: { tone: 'urgent' } },
      slotConfig: { headline: { kind: 'arms', locator: { id: 'headline' } } },
    });
  const cfg = { apiKey: KEY, slots: { decl: { dims: { tone: ['urgent'] }, target: '#decl' } } };
  const vis = (id: string) => (document.getElementById(id) as HTMLElement).style.visibility;

  it('hides ONLY the registry targets as they parse, keeping layout, until the bundle reveals', async () => {
    history.replaceState(null, '', '/products/shoe?gclid=abc');
    seed(cfg, registrySnap());
    run();
    expect(pp()!.held).toBe(true);
    await parse('<h1 id="headline" style="visibility: visible">Hi</h1><div id="decl"></div>');
    expect(vis('headline')).toBe('hidden');
    expect(vis('decl')).toBe('');
    pp()!.reveal!();
    // The merchant's own inline value comes back, not a blank.
    expect(vis('headline')).toBe('visible');
    expect(pp()!.held).toBe(false);
  });

  it('reveals on its own after 300 ms (the decide was slow)', async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/?utm_source=klaviyo&utm_medium=email&utm_campaign=abandoned');
    seed(cfg, registrySnap());
    run();
    await parse('<h1 id="headline">Hi</h1>');
    expect(vis('headline')).toBe('hidden');
    vi.advanceTimersByTime(299);
    expect(vis('headline')).toBe('hidden');
    vi.advanceTimersByTime(1);
    expect(vis('headline')).toBe('');
    expect(pp()!.held).toBe(false);
  });

  it('a stopped observer (the bundle booting) does not end the hold; reveal is idempotent', async () => {
    history.replaceState(null, '', '/?ttclid=1');
    seed(cfg, registrySnap());
    run();
    await parse('<h1 id="headline">Hi</h1>');
    pp()!.stop();
    expect(vis('headline')).toBe('hidden');
    pp()!.reveal!();
    pp()!.reveal!();
    expect(vis('headline')).toBe('');
  });

  const strong = ['/?gclid=x', '/?gbraid=x', '/?wbraid=x', '/?msclkid=x', '/?twclid=x', '/?li_fat_id=x',
    '/?utm_medium=cpc', '/?utm_medium=paid_social', '/?utm_medium=Paid-Search', '/?utm_medium=sms', '/discount/SPRING20'];
  for (const url of strong) {
    it(`holds for ${url}`, () => {
      history.replaceState(null, '', url);
      seed(cfg, registrySnap());
      run();
      expect(pp()!.held).toBe(true);
    });
  }

  // Organic and unattributed visitors pay nothing. fbclid rides organic Meta
  // clicks too; utm_medium=social is organic; an unknown medium is not paid.
  const weak = ['/', '/?fbclid=x', '/?utm_source=google&utm_medium=organic', '/?utm_medium=social',
    '/?utm_medium=cpcx', '/?ref=newsletter', '/products/shoe', '/?gclid'];
  for (const url of weak) {
    it(`does not hold for ${url}`, async () => {
      history.replaceState(null, '', url);
      seed(cfg, registrySnap());
      run();
      expect(pp()!.held).toBe(false);
      await parse('<h1 id="headline">Hi</h1>');
      expect(vis('headline')).toBe('');
    });
  }

  it('holds nothing (and arms no timer) when the snapshot names no registry target on this page', () => {
    const set = vi.spyOn(window, 'setTimeout');
    history.replaceState(null, '', '/?gclid=x');
    seed(cfg, snapshot({ slots: { decl: { tone: 'urgent' } } }));
    run();
    expect(pp()!.held).toBe(false);
    expect(set.mock.calls.filter((c) => c[1] === 300)).toHaveLength(0);
  });

  it('never holds without a snapshot (a true first visit has no targets) — the script stays out entirely', () => {
    history.replaceState(null, '', '/?gclid=x');
    seed(cfg, null);
    run();
    expect(pp()).toBeUndefined();
  });

  it('never holds an ambiguous target', async () => {
    history.replaceState(null, '', '/?gclid=x');
    seed(cfg, snapshot({ slots: { h: 'a' }, slotConfig: { h: { kind: 'arms', target: '.dup' } } }));
    run();
    await parse('<p class="dup"></p><p class="dup"></p>');
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.dup'))) expect(el.style.visibility).toBe('');
  });

  for (const [name, setup] of [
    ['consent: false', () => seed({ ...cfg, consent: false }, registrySnap())],
    ['a consent platform', () => seed({ ...cfg, consentFrom: 'cookiebot' }, registrySnap())],
  ] as Array<[string, () => void]>) {
    it(`no hold under ${name}`, () => {
      history.replaceState(null, '', '/?gclid=x');
      setup();
      run();
      expect(pp()).toBeUndefined();
    });
  }

  it('no hold under GPC', () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    try {
      history.replaceState(null, '', '/?gclid=x');
      seed(cfg, registrySnap());
      run();
      expect(pp()).toBeUndefined();
    } finally {
      Reflect.deleteProperty(navigator, 'globalPrivacyControl');
    }
  });

  it('no hold in a preview, even on a strong-intent URL', () => {
    history.replaceState(null, '', '/?gclid=x&sentient_preview=headline:cart_v1');
    seed(cfg, registrySnap());
    run();
    expect(pp()).toBeUndefined();
  });
});

describe('teardown', () => {
  it('stops observing at DOMContentLoaded', async () => {
    seed({ apiKey: KEY, slots: { hero: { dims: { tone: ['urgent'] }, target: '#hero' } } },
      snapshot({ slots: { hero: { tone: 'urgent' } } }));
    run();
    expect(pp()!.done).toBe(false);

    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(pp()!.done).toBe(true);

    // Anything inserted after the parser finished is the bundle's job.
    await parse('<div id="hero"></div>');
    expect(document.querySelector('#hero')!.hasAttribute('data-tone')).toBe(false);
  });

  it('stops on stop() — the bundle taking over', async () => {
    seed({ apiKey: KEY, slots: { hero: { dims: { tone: ['urgent'] }, target: '#hero' } } },
      snapshot({ slots: { hero: { tone: 'urgent' } } }));
    run();
    pp()!.stop();
    expect(pp()!.done).toBe(true);
    await parse('<div id="hero"></div>');
    expect(document.querySelector('#hero')!.hasAttribute('data-tone')).toBe(false);
  });

  it('stops after the hard cap, so a page that never fires DOMContentLoaded cannot leak an observer', async () => {
    vi.useFakeTimers();
    seed({ apiKey: KEY, slots: { hero: { dims: { tone: ['urgent'] }, target: '#hero' } } },
      snapshot({ slots: { hero: { tone: 'urgent' } } }));
    run();
    vi.advanceTimersByTime(3000);
    expect(pp()!.done).toBe(true);
  });
});
