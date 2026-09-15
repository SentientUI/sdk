// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, deriveSlotId } from './index';
import { generateLocator } from './locator-gen';
import { normalizePagePath, pageScopeChoices, pageScopeLabel } from './page-scope-choice';

describe('page scope choices', () => {
  it('normalizes the current path: no query/hash, no trailing slash except root', () => {
    expect(normalizePagePath('/pricing/')).toBe('/pricing');
    expect(normalizePagePath('/pricing?x=1#top')).toBe('/pricing');
    expect(normalizePagePath('/')).toBe('/');
    expect(normalizePagePath('')).toBe('/');
  });

  it('offers this page and every page; the prefix only with 2+ segments', () => {
    expect(pageScopeChoices('/pricing')).toEqual(['/pricing', '*']);
    expect(pageScopeChoices('/products/shoes/')).toEqual(['/products/shoes', '*', '/products/*']);
    expect(pageScopeChoices('/')).toEqual(['/', '*']);
  });

  it('keeps an existing scope selectable (first, so it stays the default)', () => {
    expect(pageScopeChoices('/pricing', '/blog/*')).toEqual(['/blog/*', '/pricing', '*']);
    expect(pageScopeChoices('/pricing', '*')).toEqual(['*', '/pricing']);
  });

  it('never offers a scope the server would reject', () => {
    // A literal * in a URL path is not a valid exact scope.
    expect(pageScopeChoices('/a*b/c')).toEqual(['*']);
  });

  it('labels in plain language', () => {
    expect(pageScopeLabel('/pricing', '/pricing')).toBe('This page (/pricing)');
    expect(pageScopeLabel('/pricing', '/about')).toBe('Only on /pricing');
    expect(pageScopeLabel('*', '/')).toBe('Every page');
    expect(pageScopeLabel('/products/*', '/products/a')).toBe('All pages under /products/');
  });
});

function selectByClick(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}
function clickBtn(label: string) {
  const btn = (Array.from(document.querySelectorAll('#sentient-editor-panel button')) as HTMLButtonElement[])
    .find((x) => x.textContent === label);
  if (!btn) throw new Error(`no button "${label}"`);
  (btn.onclick as ((ev: Event) => unknown) | null)?.call(btn, new MouseEvent('click'));
}
const scopeSelect = () => document.querySelector('#sentient-editor-panel select[data-field="page"]') as HTMLSelectElement | null;
const slotBody = (fetchMock: ReturnType<typeof vi.fn>) => {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/slots/'));
  return JSON.parse((call![1] as RequestInit).body as string);
};

describe('editor saves carry where the component appears', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    history.replaceState(null, '', '/products/shoes/?ref=x');
  });
  afterEach(() => { history.replaceState(null, '', '/'); });

  it('defaults a new text component to this page and sends it in target.page', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    const fetchMock = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('hero')!);

    const sel = scopeSelect()!;
    expect(sel).not.toBeNull();
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual([
      'This page (/products/shoes)', 'Every page', 'All pages under /products/',
    ]);
    expect(sel.value).toBe('/products/shoes');
    expect(document.getElementById('sentient-editor-panel')!.textContent).toContain('Where does this appear?');

    (document.querySelector('#sentient-editor-panel input[data-field="alt"]') as HTMLInputElement).value = 'Hi';
    clickBtn('Save draft');
    await vi.waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/editor/slots/'))).toBe(true));
    expect(slotBody(fetchMock).target).toMatchObject({ id: 'hero', page: '/products/shoes' });
  });

  it('sends the operator’s choice, and the slot id does not depend on it', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    const fetchMock = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    const hero = document.getElementById('hero')!;
    selectByClick(hero);
    scopeSelect()!.value = '/products/*';
    (document.querySelector('#sentient-editor-panel input[data-field="alt"]') as HTMLInputElement).value = 'Hi';
    clickBtn('Save draft');
    await vi.waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/editor/slots/'))).toBe(true));
    expect(slotBody(fetchMock).target.page).toBe('/products/*');
    // Re-editing from another page must update the SAME draft, not mint a new one.
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/editor/slots/'));
    expect(String(call![0])).toContain(encodeURIComponent(deriveSlotId('text', generateLocator(hero, document), hero)));
  });

  it('keeps an existing component’s scope as the default', async () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    const hero = document.getElementById('hero')!;
    const slotId = deriveSlotId('style', generateLocator(hero, document), hero);
    const fetchMock = vi.fn(async (...a: unknown[]) => String(a[0]).endsWith('/v1/editor/slots')
      ? new Response(JSON.stringify({ slots: [{ slot_id: slotId, target: { id: 'hero', page: '*' } }] }), { status: 200 })
      : new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20)); // let the slots list land
    selectByClick(hero);
    // Style tab form for the same element.
    const styleTab = (Array.from(document.querySelectorAll('#sentient-editor-panel button')) as HTMLButtonElement[])
      .find((x) => x.textContent?.includes('Style'))!;
    styleTab.onclick?.(new MouseEvent('click') as never);
    expect(scopeSelect()!.value).toBe('*');
  });

  it('a saved move carries the scope chosen next to “Save this arrangement”', async () => {
    document.body.innerHTML = '<main><section id="a">A</section><section id="b">B</section></main>';
    const fetchMock = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    selectByClick(document.getElementById('b')!);
    clickBtn('Move up');
    const selects = document.querySelectorAll('#sentient-editor-panel select[data-field="page"]');
    const saveBtn = (Array.from(document.querySelectorAll('#sentient-editor-panel button')) as HTMLButtonElement[])
      .find((x) => x.textContent === 'Save this arrangement')!;
    const moveSel = saveBtn.previousElementSibling!.querySelector('select') as HTMLSelectElement;
    moveSel.value = '*';
    clickBtn('Save this arrangement');
    await vi.waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/editor/slots/'))).toBe(true));
    expect(slotBody(fetchMock).target).toMatchObject({ id: 'b', page: '*' });
    // The control leaves with the preview.
    await vi.waitFor(() => expect(document.querySelectorAll('#sentient-editor-panel select[data-field="page"]').length).toBe(selects.length - 1));
  });
});
