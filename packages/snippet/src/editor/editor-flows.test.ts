// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, registerAuditTargets } from './index';

function selectByClick(el: Element) {
  // Element selection survives across mounts: the editor's capture-phase listener
  // uses stopPropagation (not stopImmediate), so same-target listeners all fire.
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}
function panelButton(label: string): HTMLButtonElement {
  const btns = Array.from(document.querySelectorAll('#sentient-editor-panel button')) as HTMLButtonElement[];
  const b = btns.find((x) => x.textContent === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}
// Activate a panel button by invoking its handler directly. Earlier mounts in
// this file leave capture-phase document listeners attached whose stopPropagation
// would kill a real dispatched click before it reached the button target.
function clickBtn(label: string) {
  const btn = panelButton(label);
  (btn.onclick as ((ev: Event) => unknown) | null)?.call(btn, new MouseEvent('click'));
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('text flow (in-panel form, no prompt)', () => {
  it('posts a two-arm text draft with an auto slot id and never calls window.prompt', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    const promptSpy = vi.spyOn(window, 'prompt');
    const fetchMock = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    clickBtn('Test different text here');

    const alt = document.querySelector('#sentient-editor-panel input[data-field="alt"]') as HTMLInputElement;
    expect(alt).not.toBeNull();
    alt.value = 'Get started free';
    clickBtn('Save draft');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/slots/'));
    expect(call).toBeTruthy();
    expect(String(call![0])).toMatch(/\/v1\/editor\/slots\/text-hero-/);
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.kind).toBe('arms');
    expect(body.draftConfig.arms[1].ops.text).toBe('Get started free');
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('does NOT save an empty alternative (would blank arm-b visitors) and shows a validation status', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    const fetchMock = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    clickBtn('Test different text here');

    // Leave "Alternative wording" blank and try to save.
    clickBtn('Save draft');

    expect(fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/slots/'))).toBeUndefined();
    const panelText = document.getElementById('sentient-editor-panel')!.textContent ?? '';
    expect(panelText).toContain('alternative wording');
  });

  it('does NOT save when the alternative equals the current text', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    const fetchMock = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    clickBtn('Test different text here');

    const alt = document.querySelector('#sentient-editor-panel input[data-field="alt"]') as HTMLInputElement;
    alt.value = 'Welcome'; // identical to the current wording
    clickBtn('Save draft');

    expect(fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/slots/'))).toBeUndefined();
  });
});

describe('goal flow (one click, no prompt, no name field)', () => {
  it('posts a click goal immediately and never calls window.prompt', async () => {
    document.body.innerHTML = '<button id="cta">Demo</button>';
    const promptSpy = vi.spyOn(window, 'prompt');
    const fetchMock = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('cta')!);
    clickBtn('Track clicks as a goal');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/goals/'));
    expect(String(call![0])).toMatch(/\/v1\/editor\/goals\/demo-/);
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.event).toBe('click');
    expect(promptSpy).not.toHaveBeenCalled();
  });
});

describe('selection recovery + breadcrumb', () => {
  const panelText = () => document.querySelector('#sentient-editor-panel')!.textContent ?? '';
  // Prefix-matched + handler-invoked directly: these buttons carry dynamic
  // labels, and a real dispatched click dies in stale capture listeners from
  // earlier mounts (same reason clickBtn exists).
  const clickBtnIncluding = (label: string) => {
    const btn = (Array.from(document.querySelectorAll('#sentient-editor-panel button')) as HTMLButtonElement[])
      .find((x) => x.textContent?.includes(label));
    expect(btn, `no button containing "${label}"`).toBeTruthy();
    (btn!.onclick as ((ev: Event) => unknown) | null)?.call(btn!, new MouseEvent('click'));
  };

  it('offers the nearest targetable ancestor when the click is not unique', async () => {
    // The span's data-framer-name is duplicated elsewhere → its locator
    // resolves to 2 elements (not unique); the id'd section resolves fine.
    document.body.innerHTML =
      '<section id="hero"><h2>Hero</h2><span data-framer-name="dup">Go</span></section>' +
      '<span data-framer-name="dup">Elsewhere</span>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.querySelector('#hero span')!);

    expect(panelText()).toContain('can’t be tracked safely');
    clickBtnIncluding('instead');
    // Reselected the section: unique status + its label.
    expect(panelText()).toContain('Matches exactly 1 element');
    expect(panelText()).toContain('Selected: Hero');
  });

  it('says what to try when no ancestor resolves either', () => {
    // Element AND its only ancestor both carry duplicated data attributes —
    // nothing on the chain targets uniquely.
    document.body.innerHTML =
      '<div data-framer-name="w"><span data-framer-name="dup">Same</span></div>' +
      '<div data-framer-name="w"><span data-framer-name="dup">Same</span></div>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.querySelector('span')!);

    expect(panelText()).toContain('try a heading, a button, or a whole section');
  });

  it('renders an ancestor breadcrumb and crumbs reselect their level', () => {
    document.body.innerHTML =
      '<section id="hero"><h2>Hero section</h2><div><button id="cta">Buy now</button></div></section>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('cta')!);

    expect(panelText()).toContain('Buy now');
    expect(panelText()).toContain('Page');
    // The section appears as a clickable crumb; clicking it reselects the section.
    clickBtnIncluding('Hero section');
    expect(panelText()).toContain('Selected: Hero section');
  });
});

describe('live preview (style + text apply as you type)', () => {
  const field = (k: string) =>
    document.querySelector(`#sentient-editor-panel [data-field="${k}"]`) as HTMLInputElement;

  it('applies style values on input and restores byte-identical cssText on Cancel', () => {
    document.body.innerHTML = '<button id="cta" style="margin:4px">Demo</button>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    const cta = document.getElementById('cta') as HTMLElement;
    const orig = cta.style.cssText;
    selectByClick(cta);
    clickBtn('Change style');

    field('fontSize').value = '22px';
    field('fontSize').dispatchEvent(new Event('input'));
    expect(cta.style.fontSize).toBe('22px');
    expect(cta.style.margin).toBe('4px'); // pre-existing inline styles survive

    clickBtn('Cancel');
    expect(cta.style.cssText).toBe(orig);
  });

  it('previews the alternative wording live, restores on Cancel, keeps it on Save', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    const hero = document.getElementById('hero')!;
    selectByClick(hero);
    clickBtn('Test different text here');

    const alt = field('alt');
    alt.value = 'Get started free';
    alt.dispatchEvent(new Event('input'));
    expect(hero.textContent).toBe('Get started free');

    // Emptying the field restores the original — backspacing never blanks it.
    alt.value = '';
    alt.dispatchEvent(new Event('input'));
    expect(hero.textContent).toBe('Welcome');

    alt.value = 'Get started free';
    alt.dispatchEvent(new Event('input'));
    clickBtn('Cancel');
    expect(hero.textContent).toBe('Welcome');

    // Save keeps the approved preview on screen (the move flow's commit rule).
    selectByClick(hero);
    clickBtn('Test different text here');
    const alt2 = field('alt');
    alt2.value = 'Get started free';
    alt2.dispatchEvent(new Event('input'));
    clickBtn('Save draft');
    await vi.waitFor(() =>
      expect(document.querySelector('#sentient-editor-panel')!.textContent).toContain('Saved as a draft'));
    expect(hero.textContent).toBe('Get started free');
  });

  it('palette swatches mark the color input as touched (value reaches the preview)', () => {
    document.body.innerHTML = '<button id="cta">Demo</button>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    const cta = document.getElementById('cta') as HTMLElement;
    selectByClick(cta);
    clickBtn('Change style');

    // The white swatch always exists regardless of what the site sampled.
    const swatch = Array.from(document.querySelectorAll('#sentient-editor-panel button'))
      .find((x) => (x as HTMLElement).title === '#ffffff') as HTMLButtonElement;
    expect(swatch).toBeTruthy();
    (swatch.onclick as ((ev: Event) => unknown) | null)?.call(swatch, new MouseEvent('click'));
    expect(field('color').value).toBe('#ffffff');
    expect(cta.style.color).toBeTruthy();
  });
});

describe('telemetry (batched, fire-and-forget)', () => {
  it('flushes opened+selected as one batch after the debounce, and a failed flush stays silent', async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = '<button id="cta">Demo</button>';
      // Telemetry endpoint rejects hard — nothing may surface in the panel.
      const fetchMock = vi.fn(async (...a: unknown[]) => {
        if (String(a[0]).includes('/v1/editor/telemetry')) throw new Error('offline');
        return new Response('{}', { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);

      mount({ token: 'tok', apiBase: 'https://api.example.com' });
      selectByClick(document.getElementById('cta')!);
      await vi.advanceTimersByTimeAsync(2100);

      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/telemetry'));
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      const kinds = body.events.map((e: { kind: string }) => e.kind);
      expect(kinds).toContain('editor_opened');
      expect(kinds).toContain('element_selected');
      expect(body.events.find((e: { kind: string }) => e.kind === 'element_selected').meta.unique).toBe(true);
      // The throw was swallowed: the panel shows normal selection state.
      expect(document.querySelector('#sentient-editor-panel')!.textContent).toContain('Matches exactly 1 element');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('collapse, drafts, and AI suggestions', () => {
  const panelEl = () => document.getElementById('sentient-editor-panel')!;
  const btnIncluding = (label: string): HTMLButtonElement => {
    const b = (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[])
      .find((x) => x.textContent?.includes(label));
    expect(b, `no button containing "${label}"`).toBeTruthy();
    return b!;
  };
  const invoke = (b: HTMLButtonElement) =>
    (b.onclick as ((ev: Event) => unknown) | null)?.call(b, new MouseEvent('click'));

  // ✨ opens an instruction box first (say what you want), then Go runs it.
  // `instruction` empty = the old "just give me ideas" path.
  const askAi = (instruction = ''): void => {
    invoke(btnIncluding('Ask AI'));
    const input = document.querySelector('#sentient-editor-panel input[data-field="ai-instruction"]') as HTMLInputElement;
    expect(input, 'the ✨ button should open an instruction box').toBeTruthy();
    input.value = instruction;
    invoke(document.querySelector('#sentient-editor-panel button[data-action="ai-go"]') as HTMLButtonElement);
  };

  it('Minimize collapses to a bubble, pauses picking, and the bubble restores both', () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    mount({ token: 'tok', apiBase: 'https://api.example.com' });

    invoke(btnIncluding('Minimize'));
    expect(panelEl().style.display).toBe('none');
    // Collapsed = paused: an invisible editor must not silently select things.
    selectByClick(document.getElementById('hero')!);
    expect(panelEl().textContent).not.toContain('Selected:');

    const bubble = document.querySelector('button[title="Open the SentientUI editor"]') as HTMLButtonElement;
    expect(bubble).toBeTruthy();
    invoke(bubble);
    expect(panelEl().style.display).toBe('block');
    selectByClick(document.getElementById('hero')!);
    expect(panelEl().textContent).toContain('Selected: Welcome');
  });

  it('Drafts tab lists saved slots with Preview and Publish', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    vi.stubGlobal('fetch', vi.fn(async (...a: unknown[]) => {
      if (String(a[0]).includes('/v1/editor/slots') && !String(a[0]).includes('publish')) {
        return new Response(JSON.stringify({ slots: [
          { slot_id: 'text-hero-x', display_name: 'Headline wording', status: 'draft', draft_config: { arms: [{ id: 'a' }, { id: 'b' }] }, published_config: null },
          { slot_id: 'style-cta-y', display_name: 'CTA style', status: 'published', draft_config: null, published_config: { arms: [{ id: 'a' }, { id: 'b' }] } },
        ] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    const draftsTab = (Array.from(panelEl().querySelectorAll('button')) as HTMLButtonElement[])
      .find((b) => b.textContent?.includes('Drafts'))!;
    invoke(draftsTab);
    await vi.waitFor(() => expect(panelEl().textContent).toContain('Headline wording'));
    expect(panelEl().textContent).toContain('CTA style');
    expect(panelEl().textContent).toContain('draft');
    expect(panelEl().textContent).toContain('live');
    // A draft row offers Publish; the published one only Preview.
    expect(btnIncluding('Publish')).toBeTruthy();
    expect(btnIncluding('Preview')).toBeTruthy();
  });

  it('💡 renders validated suggestions and "Try it" prefills the text form with live preview', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    vi.stubGlobal('fetch', vi.fn(async (...a: unknown[]) => {
      if (String(a[0]).includes('/v1/editor/suggest')) {
        return new Response(JSON.stringify({ suggestions: [
          { kind: 'text', title: 'Warmer welcome', reason: 'Generic greeting converts poorly.', variant: 'Welcome home' },
        ] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);

    askAi();
    await vi.waitFor(() => expect(panelEl().textContent).toContain('Warmer welcome'));
    expect(panelEl().textContent).toContain('Generic greeting converts poorly.');

    invoke(btnIncluding('Try it'));
    const alt = document.querySelector('#sentient-editor-panel input[data-field="alt"]') as HTMLInputElement;
    expect(alt.value).toBe('Welcome home');
    // Conservative contract: prefilled + previewed live, NOT saved — no slot
    // write may have happened.
    expect(document.getElementById('hero')!.textContent).toBe('Welcome home');
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/editor/slots/'))).toBe(false);
  });

  // The dashboard's "Test copy with AI" was the only place you could say what
  // you WANTED; the editor could only hand back unprompted ideas. Saying it
  // here — on the element — is what let that button go.
  it('sends what the operator typed as the instruction', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    const fetchMock = vi.fn(async (...a: unknown[]) => {
      if (String(a[0]).includes('/v1/editor/suggest')) {
        return new Response(JSON.stringify({ suggestions: [
          { kind: 'text', title: 'Shorter', reason: 'r', variant: 'Welcome' },
        ] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);

    askAi('shorter and more urgent');
    await vi.waitFor(() => expect(panelEl().textContent).toContain('Shorter'));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/suggest'));
    expect(JSON.parse((call![1] as RequestInit).body as string).instruction).toBe('shorter and more urgent');
  });

  it('omits the instruction entirely when the box is left blank', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    const fetchMock = vi.fn(async (...a: unknown[]) => {
      if (String(a[0]).includes('/v1/editor/suggest')) {
        return new Response(JSON.stringify({ suggestions: [] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);

    askAi();
    await vi.waitFor(() => {
      const c = fetchMock.mock.calls.find((x) => String(x[0]).includes('/v1/editor/suggest'));
      expect(c).toBeTruthy();
      expect('instruction' in JSON.parse((c![1] as RequestInit).body as string)).toBe(false);
    });
  });
});

describe('failure copy (machine codes reach the operator)', () => {
  const panelText = () => document.querySelector('#sentient-editor-panel')!.textContent ?? '';

  it('renders the plan-limit upgrade prompt on a 402, not "try again"', async () => {
    document.body.innerHTML = '<button id="cta">Demo</button>';
    const fetchMock = vi.fn(async (...a: unknown[]) => {
      const u = String(a[0]);
      if (u.includes('/publish')) {
        return new Response(JSON.stringify({ error: 'plan_limit_reached', feature: 'live_goals', plan: 'free', limit: 1 }), { status: 402 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('cta')!);
    clickBtn('Track clicks as a goal');
    // Wait for the SAVE to land (it sets pendingGoalId) — the activate button
    // exists hidden from mount, so its mere presence proves nothing.
    await vi.waitFor(() => expect(panelText()).toContain('Goal saved'));
    clickBtn('Start tracking “Demo” now');

    await vi.waitFor(() => expect(panelText()).toContain('1 live goal'));
    expect(panelText()).toContain('upgrade');
    expect(panelText()).not.toContain('try again');
  });

  it('carries the HTTP status on unmapped failures so screenshots name the cause', async () => {
    document.body.innerHTML = '<button id="cta">Demo</button>';
    vi.stubGlobal('fetch', vi.fn(async (...a: unknown[]) => {
      const u = String(a[0]);
      if (u.includes('/v1/editor/goals/')) return new Response('{}', { status: 500 });
      return new Response('{}', { status: 200 });
    }));

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('cta')!);
    clickBtn('Track clicks as a goal');

    await vi.waitFor(() => expect(panelText()).toContain('(HTTP 500)'));
  });

  it('keeps the dedicated expired copy on a 401', async () => {
    document.body.innerHTML = '<button id="cta">Demo</button>';
    vi.stubGlobal('fetch', vi.fn(async (...a: unknown[]) => {
      const u = String(a[0]);
      if (u.includes('/v1/editor/goals/')) return new Response('{}', { status: 401 });
      return new Response('{}', { status: 200 });
    }));

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('cta')!);
    clickBtn('Track clicks as a goal');

    await vi.waitFor(() => expect(panelText()).toContain('Editor session expired'));
  });
});

describe('move up/down', () => {
  it('lets a section move more than once (buttons stay usable)', () => {
    document.body.innerHTML = '<main><section id="a">A</section><section id="b">B</section><section id="c">C</section></main>';
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('c')!);
    clickBtn('Move up'); // c before b → a, c, b
    clickBtn('Move up'); // c before a → c, a, b
    const order = Array.from(document.querySelectorAll('main section')).map((s) => s.id);
    expect(order).toEqual(['c', 'a', 'b']);
  });

  it('two different sections reordered both persist (distinct slot ids — no overwrite)', async () => {
    document.body.innerHTML = '<main><section id="about">About</section><section id="contact">Contact</section><section id="faq">FAQ</section></main>';
    const fetchMock = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });

    selectByClick(document.getElementById('contact')!);
    clickBtn('Move up');
    clickBtn('Save this arrangement');
    await vi.waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/slots/')).length).toBe(1));

    selectByClick(document.getElementById('faq')!);
    clickBtn('Move up');
    clickBtn('Save this arrangement');
    await vi.waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/slots/')).length).toBe(2));

    const ids = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/v1/editor/slots/'))
      .map((c) => String(c[0]).split('/slots/')[1]);
    expect(ids[0]).not.toBe(ids[1]);            // distinct → no ON CONFLICT overwrite
    expect(ids.every((id) => id.startsWith('move-'))).toBe(true);
  });
});

describe('style flow', () => {
  it('posts an arms draft carrying style ops with an auto style- slot id', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    const fetchMock = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    clickBtn('Change style');

    const color = document.querySelector('#sentient-editor-panel input[data-field="color"]') as HTMLInputElement;
    color.value = '#ff0000';
    // The colour picker only counts as a change once the user interacts with it
    // (an untouched <input type=color> reports #000000 and must not stealth-fill).
    color.dispatchEvent(new Event('input', { bubbles: true }));
    const size = document.querySelector('#sentient-editor-panel input[data-field="fontSize"]') as HTMLInputElement;
    size.value = '20px';
    clickBtn('Save draft');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/slots/'));
    expect(String(call![0])).toMatch(/\/slots\/style-hero-/);
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.draftConfig.arms[1].ops.style).toMatchObject({ color: '#ff0000', fontSize: '20px' });
  });
});

describe('no native prompts', () => {
  it('never calls window.prompt across the text, goal, and style flows', () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    const promptSpy = vi.spyOn(window, 'prompt');
    vi.stubGlobal('fetch', vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 })));
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    for (const label of ['Test different text here', 'Track clicks as a goal', 'Change style']) {
      selectByClick(document.getElementById('hero')!);
      clickBtn(label);
    }
    expect(promptSpy).not.toHaveBeenCalled();
  });
});

describe('arrangement flow (Track B B3 — catalog picker)', () => {
  const CATALOG = {
    arrangements: [{
      id: 'cta-centered', sectionType: 'cta_band', name: 'Centered call to action',
      description: 'A short pitch and one button.',
      fields: [
        { id: 'headline', label: 'Headline', kind: 'text', default: 'Ready when you are' },
        { id: 'cta_href', label: 'Button link', kind: 'href' },
      ],
    }],
  };
  const BLOCKS = { type: 'stack', direction: 'column', children: [] };

  function fetchImpl(url: unknown): Response {
    const u = String(url);
    if (u.includes('/v1/editor/arrangements') && !u.includes('instantiate')) {
      return new Response(JSON.stringify(CATALOG), { status: 200 });
    }
    if (u.includes('/instantiate')) return new Response(JSON.stringify({ blocks: BLOCKS }), { status: 200 });
    return new Response('{}', { status: 200 });
  }

  it('lists the catalog, fills fields, and saves a blocks draft tested against the original', async () => {
    document.body.innerHTML = '<section id="hero"><h1>Now</h1><a href="https://x.example/go">Go</a></section>';
    const fetchMock = vi.fn(async (...a: unknown[]) => fetchImpl(a[0]));
    vi.stubGlobal('fetch', fetchMock);

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    clickBtn('Try a different layout for this section');

    // The chooser is fetched and rendered; pick the arrangement.
    await vi.waitFor(() => panelButton('Centered call to actionA short pitch and one button.'));
    clickBtn('Centered call to actionA short pitch and one button.');

    // Field form: headline prefilled from the SECTION'S OWN copy (the catalog
    // default is template lorem — prefilling it silently threw the site's real
    // wording away). The default only stands when the section has nothing.
    const headline = document.querySelector('#sentient-editor-panel input[data-field="headline"]') as HTMLInputElement;
    expect(headline.value).toBe('Now');
    const href = document.querySelector('#sentient-editor-panel input[data-field="cta_href"]') as HTMLInputElement;
    href.value = 'https://example.com/go';
    clickBtn('Save draft');

    await vi.waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/editor/slots/'))).toBe(true));
    const inst = fetchMock.mock.calls.find((c) => String(c[0]).includes('/instantiate'));
    expect(JSON.parse((inst![1] as RequestInit).body as string).fields.cta_href).toBe('https://example.com/go');

    const slot = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/slots/'));
    expect(String(slot![0])).toMatch(/\/v1\/editor\/slots\/arrange-/);
    const body = JSON.parse((slot![1] as RequestInit).body as string);
    expect(body.kind).toBe('arms');
    expect(body.draftConfig.baseline).toBe('original');
    expect(body.draftConfig.arms[0]).toEqual({ id: 'original', displayName: 'Your page today' });
    expect(body.draftConfig.arms[1]).toEqual({ id: 'cta-centered', displayName: 'Centered call to action', blocks: BLOCKS });
  });

  it('prefills CTA copy and https links from the section, and falls back to defaults when it has nothing', async () => {
    document.body.innerHTML =
      '<section id="hero"><h1>Move volume today</h1><p>One accountable partner.</p>' +
      '<a href="https://astra.example/contact">Talk to a desk</a></section>' +
      '<section id="empty"></section>';
    const catalog = {
      arrangements: [{
        id: 'hero-left', sectionType: 'hero', name: 'Left hero', description: 'd',
        fields: [
          { id: 'headline', label: 'Headline', kind: 'text', default: 'Template headline' },
          { id: 'supporting', label: 'Supporting line', kind: 'text', default: 'Template line' },
          { id: 'cta_label', label: 'Button', kind: 'text', default: 'Get started' },
          { id: 'cta_href', label: 'Button link', kind: 'href' },
        ],
      }],
    };
    vi.stubGlobal('fetch', vi.fn(async (...a: unknown[]) => {
      const u = String(a[0]);
      if (u.includes('/v1/editor/arrangements') && !u.includes('instantiate')) {
        return new Response(JSON.stringify(catalog), { status: 200 });
      }
      return fetchImpl(a[0]);
    }));

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    const field = (k: string): HTMLInputElement =>
      document.querySelector(`#sentient-editor-panel input[data-field="${k}"]`) as HTMLInputElement;

    // Section with real copy: every field inherits it, hrefs absolutized https.
    selectByClick(document.getElementById('hero')!);
    clickBtn('Try a different layout for this section');
    await vi.waitFor(() => panelButton('Left herod'));
    clickBtn('Left herod');
    expect(field('headline').value).toBe('Move volume today');
    expect(field('supporting').value).toBe('One accountable partner.');
    expect(field('cta_label').value).toBe('Talk to a desk');
    expect(field('cta_href').value).toBe('https://astra.example/contact');

    // Empty section: no layout is offered at all. The catalog defaults are
    // designer lorem, and a section with nothing to re-arrange used to be
    // offered every layout and then filled with them — publishing words the
    // merchant never wrote in their own brand voice.
    selectByClick(document.getElementById('empty')!);
    clickBtn('Try a different layout for this section');
    await vi.waitFor(() =>
      expect(document.querySelector('#sentient-editor-panel')!.textContent).toContain('No other layout fits this section'));
    expect(document.querySelectorAll('#sentient-editor-panel input[data-field="headline"]').length).toBe(0);
  });

  // The complaint this gate answers: a page with no testimonials could be
  // "re-arranged" into a testimonial block, which the catalog then populated
  // with invented quotes attributed to people who do not exist.
  it('offers no testimonial layout for a section that has no quotes', async () => {
    document.body.innerHTML =
      '<section id="hero"><h1>Move volume today</h1><p>One accountable partner.</p>' +
      '<a href="https://astra.example/contact">Talk to a desk</a></section>';
    const catalog = {
      arrangements: [
        { id: 'hero-left', sectionType: 'hero', name: 'Left hero', description: 'd', fields: [] },
        { id: 'testimonial-quote', sectionType: 'testimonial', name: 'Single quote', description: 'q', fields: [] },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async (...a: unknown[]) => {
      const u = String(a[0]);
      if (u.includes('/v1/editor/arrangements') && !u.includes('instantiate')) {
        return new Response(JSON.stringify(catalog), { status: 200 });
      }
      return fetchImpl(a[0]);
    }));

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    clickBtn('Try a different layout for this section');
    await vi.waitFor(() => panelButton('Left herod'));
    expect(() => panelButton('Single quoteq')).toThrow();
  });

  it('offers the testimonial layout once the section actually has a quote', async () => {
    document.body.innerHTML =
      '<section id="quotes"><h2>What clients say</h2><blockquote>It paid for itself.</blockquote>' +
      '<cite>Sam R.</cite></section>';
    const catalog = {
      arrangements: [
        { id: 'testimonial-quote', sectionType: 'testimonial', name: 'Single quote', description: 'q',
          fields: [{ id: 'quote', label: 'Quote', kind: 'text', default: '“Lorem.”' },
                   { id: 'name', label: 'Name', kind: 'text', default: 'Alex P.' }] },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async (...a: unknown[]) => {
      const u = String(a[0]);
      if (u.includes('/v1/editor/arrangements') && !u.includes('instantiate')) {
        return new Response(JSON.stringify(catalog), { status: 200 });
      }
      return fetchImpl(a[0]);
    }));

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('quotes')!);
    clickBtn('Try a different layout for this section');
    await vi.waitFor(() => panelButton('Single quoteq'));
    clickBtn('Single quoteq');
    const field = (k: string): HTMLInputElement =>
      document.querySelector(`#sentient-editor-panel input[data-field="${k}"]`) as HTMLInputElement;
    // The site's OWN quote and attribution — never the catalog's placeholders.
    expect(field('quote').value).toBe('It paid for itself.');
    expect(field('name').value).toBe('Sam R.');
  });

  it('refuses to save a layout with an empty field instead of filling it with catalog lorem', async () => {
    document.body.innerHTML =
      '<section id="hero"><h1>Now</h1><a href="https://x.example/go">Go</a></section>';
    const catalog = {
      arrangements: [{
        id: 'hero-left', sectionType: 'hero', name: 'Left hero', description: 'd',
        fields: [
          { id: 'headline', label: 'Headline', kind: 'text', default: 'Template headline' },
          { id: 'supporting', label: 'Supporting line', kind: 'text', default: 'Template line' },
        ],
      }],
    };
    const fetchMock = vi.fn(async (...a: unknown[]) => {
      const u = String(a[0]);
      if (u.includes('/v1/editor/arrangements') && !u.includes('instantiate')) {
        return new Response(JSON.stringify(catalog), { status: 200 });
      }
      return fetchImpl(a[0]);
    });
    vi.stubGlobal('fetch', fetchMock);

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    clickBtn('Try a different layout for this section');
    await vi.waitFor(() => panelButton('Left herod'));
    clickBtn('Left herod');
    // The section has no <p>, so "supporting" prefills empty — and the server
    // would substitute "Template line" for a blank, so the client must stop it.
    const field = (k: string): HTMLInputElement =>
      document.querySelector(`#sentient-editor-panel input[data-field="${k}"]`) as HTMLInputElement;
    expect(field('supporting').value).toBe('');
    clickBtn('Save draft');
    await vi.waitFor(() =>
      expect(document.querySelector('#sentient-editor-panel')!.textContent).toContain('your own words'));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/instantiate'))).toBe(false);
  });

  it('rejects a non-https link inline, before any round-trip', async () => {
    document.body.innerHTML = '<section id="hero"><h1>Now</h1><a href="https://x.example/go">Go</a></section>';
    const fetchMock = vi.fn(async (...a: unknown[]) => fetchImpl(a[0]));
    vi.stubGlobal('fetch', fetchMock);

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    clickBtn('Try a different layout for this section');
    await vi.waitFor(() => panelButton('Centered call to actionA short pitch and one button.'));
    clickBtn('Centered call to actionA short pitch and one button.');

    const href = document.querySelector('#sentient-editor-panel input[data-field="cta_href"]') as HTMLInputElement;
    href.value = '/contact';
    clickBtn('Save draft');

    await vi.waitFor(() =>
      expect(document.querySelector('#sentient-editor-panel')!.textContent).toContain('Links need to start with https://'));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/instantiate'))).toBe(false);

    // Fixing the link clears the field error and lets the save proceed.
    href.value = 'https://example.com/contact';
    clickBtn('Save draft');
    await vi.waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/instantiate'))).toBe(true));
  });

  it('surfaces an instantiate rejection verbatim and saves no slot', async () => {
    document.body.innerHTML = '<section id="hero"><h1>Now</h1><a href="https://x.example/go">Go</a></section>';
    const fetchMock = vi.fn(async (...a: unknown[]) => {
      const u = String(a[0]);
      if (u.includes('/instantiate')) {
        return new Response(JSON.stringify({ error: 'invalid_fields', reason: '"Button link" is required' }), { status: 400 });
      }
      return fetchImpl(a[0]);
    });
    vi.stubGlobal('fetch', fetchMock);

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    clickBtn('Try a different layout for this section');
    await vi.waitFor(() => panelButton('Centered call to actionA short pitch and one button.'));
    clickBtn('Centered call to actionA short pitch and one button.');
    // A valid https link so the CLIENT validation passes — this test is about
    // the server still being able to reject, and its reason surfacing verbatim.
    const href = document.querySelector('#sentient-editor-panel input[data-field="cta_href"]') as HTMLInputElement;
    href.value = 'https://example.com/go';
    clickBtn('Save draft');

    await vi.waitFor(() =>
      expect(document.querySelector('#sentient-editor-panel')!.textContent).toContain('"Button link" is required'));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/editor/slots/'))).toBe(false);
  });
});

describe('audit 2026-09-07 regressions (work-loss + suggestion hygiene)', () => {
  const panelEl = () => document.getElementById('sentient-editor-panel')!;
  const btnIncluding = (label: string): HTMLButtonElement => {
    const b = (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[])
      .find((x) => x.textContent?.includes(label));
    expect(b, `no button containing "${label}"`).toBeTruthy();
    return b!;
  };
  const invoke = (b: HTMLButtonElement) =>
    (b.onclick as ((ev: Event) => unknown) | null)?.call(b, new MouseEvent('click'));

  // ✨ opens an instruction box first (say what you want), then Go runs it.
  // `instruction` empty = the old "just give me ideas" path.
  const askAi = (instruction = ''): void => {
    invoke(btnIncluding('Ask AI'));
    const input = document.querySelector('#sentient-editor-panel input[data-field="ai-instruction"]') as HTMLInputElement;
    expect(input, 'the ✨ button should open an instruction box').toBeTruthy();
    input.value = instruction;
    invoke(document.querySelector('#sentient-editor-panel button[data-action="ai-go"]') as HTMLButtonElement);
  };

  it('a suggest response that lands after selecting another element never renders (race guard)', async () => {
    document.body.innerHTML = '<h1 id="a">Alpha</h1><h2 id="b">Beta</h2>';
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((res) => { release = res; });
    vi.stubGlobal('fetch', vi.fn(async (...args: unknown[]) => {
      if (String(args[0]).includes('/v1/editor/suggest')) return pending;
      return new Response('{}', { status: 200 });
    }));
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('a')!);
    askAi();
    // The operator moves on before the model answers.
    selectByClick(document.getElementById('b')!);
    release(new Response(JSON.stringify({ suggestions: [
      { kind: 'text', title: 'Rewrite Alpha', reason: 'r', variant: 'Alpha rewritten' },
    ] }), { status: 200 }));
    await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0));
    // Alpha's card must not appear against Beta.
    expect(panelEl().textContent).not.toContain('Rewrite Alpha');
    expect(document.getElementById('b')!.textContent).toBe('Beta');
  });

  it('a goal suggestion on a non-unique element does NOT save; it explains instead', async () => {
    // Two identical buttons → the locator cannot resolve uniquely.
    document.body.innerHTML = '<button class="x">Buy</button><button class="x">Buy</button>';
    vi.stubGlobal('fetch', vi.fn(async (...a: unknown[]) => {
      if (String(a[0]).includes('/v1/editor/suggest')) {
        return new Response(JSON.stringify({ suggestions: [
          { kind: 'goal', title: 'Track buys', reason: 'r', goalType: 'click' },
        ] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.querySelector('.x')!);
    askAi();
    await vi.waitFor(() => expect(panelEl().textContent).toContain('Track buys'));
    invoke(btnIncluding('Try it'));
    await new Promise((r) => setTimeout(r, 0));
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/editor/goals/'))).toBe(false);
    expect(panelEl().textContent).toContain('can’t be tracked reliably');
  });

  it('style suggestions: space-form rgb converts to hex; a named color is skipped, never coerced to black', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    vi.stubGlobal('fetch', vi.fn(async (...a: unknown[]) => {
      if (String(a[0]).includes('/v1/editor/suggest')) {
        return new Response(JSON.stringify({ suggestions: [
          { kind: 'style', title: 'Contrast', reason: 'r', style: { background: 'rgb(11 61 145)', color: 'white' } },
        ] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    askAi();
    await vi.waitFor(() => expect(panelEl().textContent).toContain('Contrast'));
    invoke(btnIncluding('Try it'));
    const bg = document.querySelector('#sentient-editor-panel input[data-field="background"]') as HTMLInputElement;
    expect(bg.value).toBe('#0b3d91');
    // 'white' can't ride an <input type=color> (it would coerce to #000000):
    // the field must stay untouched so the getter still reports "no change".
    const color = document.querySelector('#sentient-editor-panel input[data-field="color"]') as HTMLInputElement;
    expect(color.value).toBe('#000000'); // the input's untouched default, not a filled value
    invoke(btnIncluding('Save draft'));
    await new Promise((r) => setTimeout(r, 0));
    const call = vi.mocked(fetch).mock.calls.find((c) => String(c[0]).includes('/v1/editor/slots/'));
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.draftConfig.arms[1].ops.style).toEqual({ background: '#0b3d91' });
  });

  it('re-clicking the ACTIVE tab keeps an in-progress form (no wipe)', () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    const alt = document.querySelector('#sentient-editor-panel input[data-field="alt"]') as HTMLInputElement;
    alt.value = 'Half typed';
    const textTab = (Array.from(panelEl().querySelectorAll('button')) as HTMLButtonElement[])
      .find((b) => b.textContent?.includes('Text'))!;
    invoke(textTab);
    const after = document.querySelector('#sentient-editor-panel input[data-field="alt"]') as HTMLInputElement;
    expect(after).toBe(alt);
    expect(after.value).toBe('Half typed');
  });

  it('a failed drafts load shows a retry, not the "Nothing saved yet" empty state', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    vi.stubGlobal('fetch', vi.fn(async (...a: unknown[]) => {
      if (String(a[0]).includes('/v1/editor/slots')) return new Response('{}', { status: 500 });
      return new Response('{}', { status: 200 });
    }));
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    const draftsTab = (Array.from(panelEl().querySelectorAll('button')) as HTMLButtonElement[])
      .find((b) => b.textContent?.includes('Drafts'))!;
    invoke(draftsTab);
    await vi.waitFor(() => expect(panelEl().textContent).toContain('Couldn’t load your drafts'));
    expect(panelEl().textContent).not.toContain('Nothing saved yet');
    expect(btnIncluding('Retry')).toBeTruthy();
  });

  it('a dirty form warns on a stray page click; the second click on that element proceeds', () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1><p id="other">Elsewhere</p>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    const alt = document.querySelector('#sentient-editor-panel input[data-field="alt"]') as HTMLInputElement;
    alt.value = 'Half typed';
    alt.dispatchEvent(new Event('input', { bubbles: true })); // marks the form dirty
    selectByClick(document.getElementById('other')!);
    expect(panelEl().textContent).toContain('unsaved changes');
    expect(panelEl().textContent).toContain('Selected: Welcome'); // selection unchanged
    selectByClick(document.getElementById('other')!); // the confirming repeat click
    expect(panelEl().textContent).toContain('Selected: Elsewhere');
  });

  it('Escape closes the form first, then deselects via the same path as the Page crumb', () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    expect(document.querySelector('#sentient-editor-panel input[data-field="alt"]')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('#sentient-editor-panel input[data-field="alt"]')).toBeNull();
    expect(panelEl().textContent).toContain('Selected: Welcome'); // still selected
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panelEl().textContent).not.toContain('Selected:');
    expect(panelEl().textContent).toContain('Click any element on the page');
  });

  it('closing the editor undoes an unsaved move (after the unsaved-work confirm) and removes the keyframes sheet', () => {
    document.body.innerHTML = '<main><section id="a">A</section><section id="b">B</section></main>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('b')!);
    clickBtn('Move up');
    expect(document.querySelector('main')!.firstElementChild!.id).toBe('b'); // previewed move applied
    clickBtn('Close editor'); // first click warns — a pending move is unsaved work
    expect(panelEl().textContent).toContain('Unsaved changes');
    clickBtn('Close editor'); // confirmed
    expect(document.getElementById('sentient-editor-panel')).toBeNull();
    expect(document.querySelector('main')!.firstElementChild!.id).toBe('a'); // move undone
    expect(document.getElementById('sentient-editor-styles')).toBeNull();
  });

});

describe('review card, drafts discard, goals in drafts, keyboard (spec §2.2 + phase 3)', () => {
  const panelEl = () => document.getElementById('sentient-editor-panel')!;
  const panelText = () => document.getElementById('sentient-editor-panel')?.textContent ?? '';
  const btnIncluding = (label: string): HTMLButtonElement => {
    const b = (Array.from(document.querySelectorAll('#sentient-editor-panel button')) as HTMLButtonElement[])
      .find((x) => x.textContent?.includes(label));
    expect(b, `no button containing "${label}"`).toBeTruthy();
    return b!;
  };
  const invoke = (b: HTMLButtonElement) =>
    (b.onclick as ((ev: Event) => unknown) | null)?.call(b, new MouseEvent('click'));

  it('a slot save renders the review card; Discard is two-step, DELETEs bodylessly, and retires the publish button', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    const fetchMock = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    const alt = document.querySelector('#sentient-editor-panel input[data-field="alt"]') as HTMLInputElement;
    alt.value = 'Welcome home';
    clickBtn('Save draft');

    await vi.waitFor(() => expect(panelText()).toContain('nothing is live for visitors yet'));
    expect(btnIncluding('Preview')).toBeTruthy(); // preview reachable from the card, not only the Drafts tab

    const disc = btnIncluding('Discard');
    invoke(disc);
    expect(disc.textContent).toBe('Sure?'); // first press arms, never deletes
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
    invoke(disc);
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) =>
        (c[1] as RequestInit | undefined)?.method === 'DELETE' && /\/v1\/editor\/slots\/text-hero-/.test(String(c[0])))).toBe(true));
    // Bodyless DELETE must NOT claim JSON — Fastify 400s an empty JSON body.
    const delCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')!;
    expect(Object.keys((delCall[1] as RequestInit).headers as Record<string, string>)).not.toContain('content-type');
    await vi.waitFor(() => expect(panelText()).toContain('Draft discarded'));
    expect(btnIncluding('go live').style.display).toBe('none'); // pending publish retired with the draft
  });

  it('the Drafts tab lists goal drafts with Start tracking + Discard, hiding synthetic SDK rows', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    const fetchMock = vi.fn(async (...a: unknown[]) => {
      const u = String(a[0]);
      if (u.includes('/v1/editor/slots')) return new Response(JSON.stringify({ slots: [] }), { status: 200 });
      if (u.includes('/v1/editor/goals') && !(a[1] as RequestInit | undefined)?.method) {
        return new Response(JSON.stringify({ goals: [
          { goal_id: 'demo-clicks-x', display_name: "Clicks on 'Demo'", event: 'click', status: 'draft' },
          { goal_id: 'sdk-only', display_name: null, event: 'custom', status: 'active' },
        ] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    const draftsTab = (Array.from(panelEl().querySelectorAll('button')) as HTMLButtonElement[])
      .find((x) => x.textContent?.includes('Drafts'))!;
    invoke(draftsTab);

    await vi.waitFor(() => expect(panelText()).toContain("Clicks on 'Demo'"));
    // Synthetic union rows for SDK-fired goals have nothing to track or discard.
    expect(panelText()).not.toContain('sdk-only');
    expect(panelButton('Start tracking')).toBeTruthy();
    const disc = btnIncluding('Discard');
    invoke(disc); // arm
    invoke(disc); // run
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) =>
        (c[1] as RequestInit | undefined)?.method === 'DELETE' && String(c[0]).includes('/v1/editor/goals/demo-clicks-x'))).toBe(true));
  });

  it('ArrowDown moves the selected element with exactly the Move buttons’ guards', () => {
    document.body.innerHTML = '<main><section id="a">A</section><section id="b">B</section></main>';
    vi.stubGlobal('fetch', vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 })));
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('a')!);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.querySelector('main')!.firstElementChild!.id).toBe('b'); // a moved below b
    // At the bottom edge the direction is disabled — a further ArrowDown no-ops.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.querySelector('main')!.lastElementChild!.id).toBe('a');
  });

  it('Tab cycles the audit targets that resolve on this page (keyboard element picking)', () => {
    document.body.innerHTML = '<button id="cta">Request a demo</button><h1 id="head">Welcome</h1>';
    vi.stubGlobal('fetch', vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 })));
    registerAuditTargets([
      { id: 't1', kind: 'cta', pageUrl: '/', label: 'Main CTA', locator: { id: 'cta' } as never, confidence: 'high', evidence: [] },
      { id: 't2', kind: 'headline', pageUrl: '/', label: 'Headline', locator: { id: 'head' } as never, confidence: 'high', evidence: [] },
      { id: 't3', kind: 'form', pageUrl: '/', label: 'Missing', locator: { id: 'ghost' } as never, confidence: 'high', evidence: [] },
    ]);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(panelText()).toContain('Selected: Request a demo');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(panelText()).toContain('Selected: Welcome');
    // Wraps past the unresolvable third target back to the first.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(panelText()).toContain('Selected: Request a demo');
    registerAuditTargets([]);
  });

  it('Esc with nothing to back out of arms, and a second Esc closes the editor', () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    vi.stubGlobal('fetch', vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 })));
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panelText()).toContain('Press Esc again to close the editor');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('sentient-editor-panel')).toBeNull();
  });
});
