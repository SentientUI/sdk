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

describe('panel sections', () => {
  it('groups actions under Content & style / Track a goal / Move labels once selected', () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);
    const text = panelText();
    expect(text).toContain('Content & style');
    expect(text).toContain('Track a goal');
    expect(text).toContain('Move');
  });

  it('hides element actions until something is selected (only the hint + page goal show)', () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    expect(panelButton('Test different text here').style.display).toBe('none');
    expect(panelButton('Track page visits as a goal').style.display).not.toBe('none');
    selectByClick(document.getElementById('hero')!);
    expect(panelButton('Test different text here').style.display).not.toBe('none');
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

  it('offers Start tracking now after a goal saves, which activates the draft', async () => {
    document.body.innerHTML = '<button id="cta">Request a demo</button>';
    const fetchMock = vi.mocked(fetch);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('cta')!);
    clickBtn('Track clicks as a goal');
    // Wait for the save RESPONSE to be handled (not just the request sent) —
    // that's when the activation button reveals.
    await vi.waitFor(() => expect(panelButton('Start tracking now').style.display).toBe('block'));
    clickBtn('Start tracking now');
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
