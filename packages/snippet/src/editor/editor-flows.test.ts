// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from './index';

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
    document.body.innerHTML = '<section id="hero"><h1>Now</h1></section>';
    const fetchMock = vi.fn(async (...a: unknown[]) => fetchImpl(a[0]));
    vi.stubGlobal('fetch', fetchMock);

    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    clickBtn('Try a different arrangement');

    // The chooser is fetched and rendered; pick the arrangement.
    await vi.waitFor(() => panelButton('Centered call to actionA short pitch and one button.'));
    clickBtn('Centered call to actionA short pitch and one button.');

    // Field form: headline prefilled with its default, link empty and required.
    const headline = document.querySelector('#sentient-editor-panel input[data-field="headline"]') as HTMLInputElement;
    expect(headline.value).toBe('Ready when you are');
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

  it('surfaces an instantiate rejection verbatim and saves no slot', async () => {
    document.body.innerHTML = '<section id="hero"><h1>Now</h1></section>';
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
    clickBtn('Try a different arrangement');
    await vi.waitFor(() => panelButton('Centered call to actionA short pitch and one button.'));
    clickBtn('Centered call to actionA short pitch and one button.');
    clickBtn('Save draft');

    await vi.waitFor(() =>
      expect(document.querySelector('#sentient-editor-panel')!.textContent).toContain('"Button link" is required'));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/editor/slots/'))).toBe(false);
  });
});
