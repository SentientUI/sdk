// @vitest-environment jsdom
// UX contract for the editor overlay: persistent selection, grouped panel
// sections, richer goal tracking, and move feedback.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from './index';

function selectByClick(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}
function panelButton(label: string): HTMLButtonElement {
  const btns = Array.from(document.querySelectorAll('#sentient-editor-panel button')) as HTMLButtonElement[];
  const b = btns.find((x) => x.textContent === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}
function clickBtn(label: string) {
  const btn = panelButton(label);
  (btn.onclick as ((ev: Event) => unknown) | null)?.call(btn, new MouseEvent('click'));
}
function panelText(): string {
  return document.getElementById('sentient-editor-panel')?.textContent ?? '';
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 })));
});

describe('selection persistence', () => {
  it('keeps a selection ring on the chosen element while the mouse moves elsewhere', () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1><p id="other">Other</p>';
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);

    const ring = document.getElementById('sentient-editor-selection')!;
    expect(ring).not.toBeNull();
    expect(ring.style.display).toBe('block');

    // Hovering another element moves the HOVER highlight, not the selection ring.
    document.getElementById('other')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(ring.style.display).toBe('block');
  });

  it('names the selected element in the panel so forms are unambiguous', () => {
    document.body.innerHTML = '<button id="cta">Request a demo</button>';
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('cta')!);
    expect(panelText()).toContain('Request a demo');
  });
});

describe('panel tabs (one concern at a time)', () => {
  it('renders the six tabs and auto-opens the text form for an eligible selection', () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    for (const tab of ['Text', 'Style', 'Layout', 'Goals', 'Funnels', 'Drafts']) {
      expect(panelText()).toContain(tab);
    }
    selectByClick(document.getElementById('hero')!);
    // Default tab is Text; an eligible leaf selection opens the form directly —
    // a tab whose whole content was one button cost an extra click for nothing.
    expect(panelText()).toContain('Alternative wording to test');
  });

  it('shows a guiding hint until something is selected; the trigger buttons stay headless', () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    expect(panelText()).toContain('Click any text on the page');
    // Page-level goals never needed a selection — their button keeps its own
    // visibility semantics inside the Goals tab.
    expect(panelButton('Track page visits as a goal').style.display).not.toBe('none');
    selectByClick(document.getElementById('hero')!);
    // Text/Style are headless: their TAB opens the form, the buttons never render.
    expect(panelButton('Test different text here').style.display).toBe('none');
  });
});

describe('goal tracking beyond clicks', () => {
  it('saves a click goal in ONE click — no name field, id derived from the element', async () => {
    document.body.innerHTML = '<button id="cta">Request a demo</button>';
    const fetchMock = vi.mocked(fetch);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('cta')!);
    clickBtn('Track clicks as a goal');

    // No form step: the goal name is derived (display name server-side).
    expect(document.querySelector('#sentient-editor-panel input[data-field="goal"]')).toBeNull();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/editor/goals/'))).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/goals/'))!;
    expect(String(call[0])).toMatch(/\/v1\/editor\/goals\/request-a-demo-/); // slug + uniqueness suffix
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.event).toBe('click');
  });

  it('seeds the goal id from a clean label, never a container\'s glued-together text', async () => {
    // A card's textContent is every descendant run together, which used to
    // slugify into `add-to-cartfrom-29-00-sold-out-...`. Past a label's length
    // it is page content, so fall back to a name the element carries — the same
    // rule the server applies to the display name.
    document.body.innerHTML =
      '<div id="product-card" aria-label="Product card">Add to cart<span>From $29.00</span><span>Sold out</span><span>Subscribe and save 10% on every order</span></div>';
    const fetchMock = vi.mocked(fetch);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('product-card')!);
    clickBtn('Track clicks as a goal');

    await vi.waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/editor/goals/'))).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/goals/'))!;
    expect(String(call[0])).toMatch(/\/v1\/editor\/goals\/product-card-/);
    expect(String(call[0])).not.toContain('sold-out');
  });

  it('collapses whitespace in the goal id seed', async () => {
    // textContent carries the source's newlines and indentation between spans.
    document.body.innerHTML = '<button id="b">Request\n\n      a demo</button>';
    const fetchMock = vi.mocked(fetch);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('b')!);
    clickBtn('Track clicks as a goal');

    await vi.waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/editor/goals/'))).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/goals/'))!;
    expect(String(call[0])).toMatch(/\/v1\/editor\/goals\/request-a-demo-/);
  });

  it('two same-text elements get DISTINCT goal ids (no silent overwrite)', async () => {
    document.body.innerHTML = '<button id="top">Sign up</button><button id="bottom">Sign up</button>';
    const fetchMock = vi.mocked(fetch);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });

    selectByClick(document.getElementById('top')!);
    clickBtn('Track clicks as a goal');
    await vi.waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/v1/editor/goals/')).length).toBe(1));
    selectByClick(document.getElementById('bottom')!);
    clickBtn('Track clicks as a goal');
    await vi.waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/v1/editor/goals/')).length).toBe(2));

    const ids = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/v1/editor/goals/'))
      .map((c) => String(c[0]).split('/goals/')[1]);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('tracks form submissions in one click, targeting the form', async () => {
    document.body.innerHTML = '<form id="signup"><input><button id="send">Send</button></form>';
    const fetchMock = vi.mocked(fetch);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('send')!);

    clickBtn('Track form submissions as a goal');

    await vi.waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/editor/goals/'))).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/goals/'))!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.event).toBe('form_submit');
    expect(body.locator.id).toBe('signup'); // the FORM, not the button
  });

  it('tracks reaching the current page in one click, without any selection', async () => {
    document.body.innerHTML = '<h1>Thanks</h1>';
    const fetchMock = vi.mocked(fetch);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });

    clickBtn('Track page visits as a goal');

    await vi.waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/editor/goals/'))).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/goals/'))!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.event).toBe('url_reached');
    expect(typeof body.urlPattern).toBe('string');
    expect(body.urlPattern.length).toBeGreaterThan(0);
  });

  it('scroll goal button opens the depth picker and saves a scroll_depth draft', async () => {
    document.body.innerHTML = '<h1>Post</h1>';
    const fetchMock = vi.mocked(fetch);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });

    clickBtn('Track reading this far as a goal');
    const select = document.querySelector('#sentient-editor-panel select[data-field="depth"]') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    select!.value = '75% — read most of the page';
    clickBtn('Track it');

    await vi.waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/editor/goals/read-75pct'))).toBe(true));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/goals/read-75pct'))!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toEqual({ event: 'scroll_depth', threshold: 0.75 });
  });

  it('offers Start tracking now after a goal saves, which activates the draft', async () => {
    document.body.innerHTML = '<button id="cta">Request a demo</button>';
    const fetchMock = vi.mocked(fetch);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('cta')!);
    clickBtn('Track clicks as a goal');
    // Wait for the save RESPONSE to be handled (not just the request sent) —
    // that's when the activation button reveals.
    // The button NAMES its goal so a later selection can't make it ambiguous.
    await vi.waitFor(() => expect(panelButton('Start tracking “Request a demo” now').style.display).toBe('block'));
    clickBtn('Start tracking “Request a demo” now');
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => /\/goals\/request-a-demo-[a-z0-9]+\/publish/.test(String(c[0])))).toBe(true),
    );
  });
});

describe('move feedback', () => {
  it('scrolls the element into view after a move so the user sees where it went', () => {
    document.body.innerHTML = '<main><section id="a">A</section><section id="b">B</section></main>';
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('b')!);
    clickBtn('Move up');
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('explains WHY a move direction is unavailable instead of silently greying out', () => {
    document.body.innerHTML = '<main><section id="a">A</section><section id="b">B</section></main>';
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('a')!); // first child — can't move up
    const up = panelButton('Move up');
    expect(up.disabled).toBe(true);
    expect(up.title.length).toBeGreaterThan(0);
  });
});
