import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { drawTargetHighlights, clearTargetHighlights, buildStyleOps, styleFieldError, type AuditTarget } from './index';
import { resolveLocatorOne } from '../locator';

const TARGET_HIGHLIGHT_SELECTOR = '.sentient-editor-target-highlight';

function makeTarget(overrides: Partial<AuditTarget> = {}): AuditTarget {
  return {
    id: 't1', kind: 'headline', pageUrl: '/', label: 'Main headline',
    locator: { id: 'hero-h1' }, confidence: 'high', evidence: [],
    ...overrides,
  };
}

describe('drawTargetHighlights', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('draws an outline + label chip for a target that resolves on the page', () => {
    document.body.innerHTML = '<h1 id="hero-h1">Welcome</h1>';
    drawTargetHighlights([makeTarget()], document);
    const nodes = document.querySelectorAll(TARGET_HIGHLIGHT_SELECTOR);
    expect(nodes.length).toBe(2); // outline box + label chip
    expect(document.body.textContent).toContain('Main headline');
  });

  it('silently skips a target whose locator does not resolve', () => {
    document.body.innerHTML = '<h1 id="hero-h1">Welcome</h1>';
    drawTargetHighlights([makeTarget({ locator: { id: 'does-not-exist' } })], document);
    expect(document.querySelectorAll(TARGET_HIGHLIGHT_SELECTOR).length).toBe(0);
  });

  it('silently skips a target whose locator is ambiguous (resolves to >1 element)', () => {
    document.body.innerHTML = '<a class="cta">one</a><a class="cta">two</a>';
    drawTargetHighlights([makeTarget({ locator: { selector: '.cta' } })], document);
    expect(document.querySelectorAll(TARGET_HIGHLIGHT_SELECTOR).length).toBe(0);
  });

  it('caps highlights at 10 even when more targets resolve', () => {
    document.body.innerHTML = Array.from({ length: 15 }, (_, i) => `<div id="t${i}">x</div>`).join('');
    const targets = Array.from({ length: 15 }, (_, i) =>
      makeTarget({ id: `t${i}`, locator: { id: `t${i}` }, label: `Target ${i}` }));
    drawTargetHighlights(targets, document);
    // 10 resolved targets * 2 nodes each (outline box + chip) = 20
    expect(document.querySelectorAll(TARGET_HIGHLIGHT_SELECTOR).length).toBe(20);
  });

  it('clearTargetHighlights removes previously drawn nodes', () => {
    document.body.innerHTML = '<h1 id="hero-h1">Welcome</h1>';
    drawTargetHighlights([makeTarget()], document);
    expect(document.querySelectorAll(TARGET_HIGHLIGHT_SELECTOR).length).toBeGreaterThan(0);
    clearTargetHighlights(document);
    expect(document.querySelectorAll(TARGET_HIGHLIGHT_SELECTOR).length).toBe(0);
  });

  it('redrawing clears any previous highlights first (no accumulation)', () => {
    document.body.innerHTML = '<h1 id="hero-h1">Welcome</h1><h2 id="sub">Sub</h2>';
    drawTargetHighlights([makeTarget()], document);
    drawTargetHighlights([makeTarget({ id: 't2', locator: { id: 'sub' }, label: 'Subheadline' })], document);
    expect(document.querySelectorAll(TARGET_HIGHLIGHT_SELECTOR).length).toBe(2);
    expect(document.body.textContent).toContain('Subheadline');
    expect(document.body.textContent).not.toContain('Main headline');
  });
});

describe('editor boot: target pre-highlighting', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.resetModules();
    delete (window as unknown as { __sentientEditor?: unknown }).__sentientEditor;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches targets after verify and draws highlights for resolvable ones; hover clears them; click still selects', async () => {
    document.body.innerHTML = '<h1 id="hero-h1">Welcome</h1>';
    (window as unknown as { __sentientEditor: { token: string; apiBase: string } }).__sentientEditor = {
      token: 'tok', apiBase: 'https://api.example.com',
    };

    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/editor/verify')) {
        return new Response(JSON.stringify({ projectId: 'p1' }), { status: 200 });
      }
      if (url.endsWith('/v1/editor/targets')) {
        return new Response(JSON.stringify({ targets: [makeTarget()] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./index');

    // Panel mounts, then targets are fetched (best-effort) and drawn.
    await vi.waitFor(() => {
      expect(document.getElementById('sentient-editor-panel')).not.toBeNull();
      expect(document.querySelectorAll(TARGET_HIGHLIGHT_SELECTOR).length).toBeGreaterThan(0);
    });

    const h1 = document.getElementById('hero-h1')!;

    // Moving the mouse to pick an element takes over — pre-highlights clear.
    h1.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(document.querySelectorAll(TARGET_HIGHLIGHT_SELECTOR).length).toBe(0);

    // The pointer-events:none outlines never intercepted clicks — the existing
    // capture-phase click handler still selects the element normally.
    h1.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const textBtn = document.querySelectorAll('#sentient-editor-panel button')[0] as HTMLButtonElement;
    expect(textBtn.disabled).toBe(false);
  });

  it('never mounts (and never fetches targets) when the token fails verification', async () => {
    document.body.innerHTML = '<h1 id="hero-h1">Welcome</h1>';
    (window as unknown as { __sentientEditor: { token: string; apiBase: string } }).__sentientEditor = {
      token: 'bad', apiBase: 'https://api.example.com',
    };

    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await import('./index');
    await new Promise((r) => setTimeout(r, 0));

    expect(document.getElementById('sentient-editor-panel')).toBeNull();
    expect(document.querySelectorAll(TARGET_HIGHLIGHT_SELECTOR).length).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only /verify — /targets never called
  });

  it('shows an expired-session notice (not the panel) when the token is unauthorized on load', async () => {
    document.body.innerHTML = '<h1 id="hero-h1">Welcome</h1>';
    (window as unknown as { __sentientEditor: { token: string; apiBase: string } }).__sentientEditor = {
      token: 'expired', apiBase: 'https://api.example.com',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));

    await import('./index');

    await vi.waitFor(() => {
      expect(document.getElementById('sentient-editor-toast')).not.toBeNull();
    });
    // A toast, never the editor panel; the copy names the fix and reassures.
    expect(document.getElementById('sentient-editor-panel')).toBeNull();
    expect(document.getElementById('sentient-editor-toast')!.textContent).toContain('expired');
  });

  it('shows a load-error notice (not a blank page) on a non-401 verify failure so the user knows to reopen it', async () => {
    document.body.innerHTML = '<h1 id="hero-h1">Welcome</h1>';
    (window as unknown as { __sentientEditor: { token: string; apiBase: string } }).__sentientEditor = {
      token: 'tok', apiBase: 'https://api.example.com',
    };
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    await import('./index');

    await vi.waitFor(() => {
      expect(document.getElementById('sentient-editor-toast')).not.toBeNull();
    });
    // Never the panel; distinct copy from the 401 expiry (a retry may well work).
    expect(document.getElementById('sentient-editor-panel')).toBeNull();
    const txt = document.getElementById('sentient-editor-toast')!.textContent ?? '';
    expect(txt).toContain('reopen it from your dashboard');
    expect(txt).not.toContain('expired');
  });

  it('clears the cached editor token when the token is unauthorized so a reload does not reopen a dead session', async () => {
    document.body.innerHTML = '<h1 id="hero-h1">Welcome</h1>';
    sessionStorage.setItem('__snt_editor_token', 'expired');
    (window as unknown as { __sentientEditor: { token: string; apiBase: string } }).__sentientEditor = {
      token: 'expired', apiBase: 'https://api.example.com',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));

    await import('./index');
    await vi.waitFor(() => {
      expect(document.getElementById('sentient-editor-toast')).not.toBeNull();
    });
    expect(sessionStorage.getItem('__snt_editor_token')).toBeNull();
  });

  it('is best-effort: a failing targets fetch never breaks the editor', async () => {
    document.body.innerHTML = '<h1 id="hero-h1">Welcome</h1>';
    (window as unknown as { __sentientEditor: { token: string; apiBase: string } }).__sentientEditor = {
      token: 'tok', apiBase: 'https://api.example.com',
    };

    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/editor/verify')) {
        return new Response(JSON.stringify({ projectId: 'p1' }), { status: 200 });
      }
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./index');

    await vi.waitFor(() => {
      expect(document.getElementById('sentient-editor-panel')).not.toBeNull();
    });
    expect(document.querySelectorAll(TARGET_HIGHLIGHT_SELECTOR).length).toBe(0);
  });
});

describe('editor panel: Move up / Move down', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.resetModules();
    delete (window as unknown as { __sentientEditor?: unknown }).__sentientEditor;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function getButton(text: string): HTMLButtonElement {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('#sentient-editor-panel button'));
    const btn = buttons.find((b) => b.textContent === text);
    if (!btn) throw new Error(`button not found: ${text}`);
    return btn;
  }

  function click(node: Element): void {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  // Panel buttons are invoked by calling their `onclick` handler directly
  // rather than dispatching+relying on capture-phase propagation from
  // `document` down to the button: this test file's jsdom `document` persists
  // across every `it()` in the file, and each `mountEditor()` call (here and
  // in the "editor boot" describe above) adds a fresh capture-phase 'click'
  // listener without a matching teardown (only the "Close editor" button
  // removes it). A stale listener from an earlier test calls
  // `e.stopPropagation()` on every click once its own (by-then-detached)
  // panel no longer contains the event target, which blocks the event from
  // ever reaching a button element. None of the button handlers below read
  // the event argument, so calling them directly is behaviorally equivalent.
  function clickButton(btn: HTMLButtonElement): void {
    const handler = btn.onclick as ((ev: Event) => unknown) | null;
    handler?.call(btn, new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  async function mountEditor(): Promise<ReturnType<typeof vi.fn>> {
    (window as unknown as { __sentientEditor: { token: string; apiBase: string } }).__sentientEditor = {
      token: 'tok', apiBase: 'https://api.example.com',
    };
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/editor/verify')) {
        return new Response(JSON.stringify({ projectId: 'p1' }), { status: 200 });
      }
      if (url.endsWith('/v1/editor/targets')) {
        return new Response(JSON.stringify({ targets: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await import('./index');
    await vi.waitFor(() => {
      expect(document.getElementById('sentient-editor-panel')).not.toBeNull();
    });
    return fetchMock;
  }

  it('clears the cached editor token on close so a reload does not reopen the editor', async () => {
    document.body.innerHTML = '<div id="root"><p id="one">One</p></div>';
    sessionStorage.setItem('__snt_editor_token', 'tok');
    await mountEditor();

    clickButton(getButton('Close editor'));

    expect(sessionStorage.getItem('__snt_editor_token')).toBeNull();
    expect(document.getElementById('sentient-editor-panel')).toBeNull();
  });

  it('enables Move up/Move down based on which siblings exist', async () => {
    document.body.innerHTML = '<div id="root"><p id="one">One</p><p id="two">Two</p><p id="three">Three</p></div>';
    await mountEditor();

    click(document.getElementById('two')!); // has both siblings
    expect(getButton('Move up').disabled).toBe(false);
    expect(getButton('Move down').disabled).toBe(false);

    click(document.getElementById('one')!); // no previous sibling
    expect(getButton('Move up').disabled).toBe(true);
    expect(getButton('Move down').disabled).toBe(false);

    click(document.getElementById('three')!); // no next sibling
    expect(getButton('Move up').disabled).toBe(false);
    expect(getButton('Move down').disabled).toBe(true);
  });

  it('disables a direction when the sibling exists but its locator cannot resolve uniquely', async () => {
    document.body.innerHTML =
      '<div id="root"><span data-framer-name="dup">Prev</span><p id="mid">Mid</p><p id="next">Next</p></div>' +
      '<span data-framer-name="dup">Elsewhere</span>';
    await mountEditor();

    click(document.getElementById('mid')!);
    // The previous sibling has no id, and its data-attr value is duplicated
    // elsewhere on the page, so its generated locator resolves to 2 elements
    // (not unique) — Move up must stay disabled.
    expect(getButton('Move up').disabled).toBe(true);
    expect(getButton('Move down').disabled).toBe(false);
  });

  it('keeps Move up/Move down disabled when the SELECTED element is not uniquely targetable, even with unique siblings', async () => {
    document.body.innerHTML =
      '<div id="root"><p id="one">One</p><span data-framer-name="dup">Selected</span><p id="three">Three</p></div>' +
      '<span data-framer-name="dup">Elsewhere</span>';
    await mountEditor();
    const selectedEl = document.querySelector('#root span[data-framer-name="dup"]')!;

    click(selectedEl);
    // The selected span has no id and its data-attr value is duplicated
    // elsewhere → its own locator resolves to 2 elements (not unique), so a
    // saved reorder draft's `target` would never resolve. Both siblings are
    // uniquely targetable (#one, #three), yet Move up/down MUST stay disabled
    // because the target itself is not unique.
    expect(getButton('Move up').disabled).toBe(true);
    expect(getButton('Move down').disabled).toBe(true);
    expect(getButton('Test different text here').disabled).toBe(true); // same gate as text/goal
  });

  it('Move up previews the new order; Undo restores the original order', async () => {
    document.body.innerHTML = '<div id="root"><p id="one">One</p><p id="two">Two</p><p id="three">Three</p></div>';
    await mountEditor();
    const root = document.getElementById('root')!;

    click(document.getElementById('two')!);
    clickButton(getButton('Move up'));

    expect(Array.from(root.children).map((c) => c.id)).toEqual(['two', 'one', 'three']);
    expect(getButton('Save this arrangement').style.display).not.toBe('none');
    expect(getButton('Undo').style.display).not.toBe('none');
    // Buttons stay usable so moves can be chained: 'two' is now first (no prev →
    // Move up disabled) but can still move down.
    expect(getButton('Move up').disabled).toBe(true);
    expect(getButton('Move down').disabled).toBe(false);

    clickButton(getButton('Undo'));

    expect(Array.from(root.children).map((c) => c.id)).toEqual(['one', 'two', 'three']);
    expect(getButton('Save this arrangement').style.display).toBe('none');
    expect(getButton('Undo').style.display).toBe('none');
    expect(getButton('Move up').disabled).toBe(false);
    expect(getButton('Move down').disabled).toBe(false);
  });

  it('Move down previews the element moving after its next sibling', async () => {
    document.body.innerHTML = '<div id="root"><p id="one">One</p><p id="two">Two</p><p id="three">Three</p></div>';
    await mountEditor();
    const root = document.getElementById('root')!;

    click(document.getElementById('two')!);
    clickButton(getButton('Move down'));

    expect(Array.from(root.children).map((c) => c.id)).toEqual(['one', 'three', 'two']);
  });

  it('selecting a different element abandons an unsaved move preview', async () => {
    document.body.innerHTML = '<div id="root"><p id="one">One</p><p id="two">Two</p><p id="three">Three</p></div>';
    await mountEditor();
    const root = document.getElementById('root')!;

    click(document.getElementById('two')!);
    clickButton(getButton('Move up'));
    expect(Array.from(root.children).map((c) => c.id)).toEqual(['two', 'one', 'three']);

    click(document.getElementById('three')!);
    expect(Array.from(root.children).map((c) => c.id)).toEqual(['one', 'two', 'three']);
  });

  it('Save posts a moveBefore draft anchored on the original previous sibling, targeting the selected element', async () => {
    document.body.innerHTML = '<div id="root"><p id="one">One</p><p id="two">Two</p><p id="three">Three</p></div>';
    const fetchMock = await mountEditor();
    const one = document.getElementById('one')!;
    const two = document.getElementById('two')!;

    click(two);
    clickButton(getButton('Move up'));
    clickButton(getButton('Save this arrangement'));

    const isSlotCall = ([url]: unknown[]) => String(url).includes('/v1/editor/slots/');
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(isSlotCall)).toBe(true);
    });

    const call = fetchMock.mock.calls.find(isSlotCall)!;
    expect(String(call[0])).toMatch(/\/v1\/editor\/slots\/move-/); // auto id, no prompt
    const init = call[1] as RequestInit;
    const body = JSON.parse(init.body as string);

    expect(body.kind).toBe('arms');
    expect(body.draftConfig.arms[0]).toEqual({ id: 'a', ops: {} });
    // 'two' moved to first position → its resting anchor is its current next
    // sibling ('one'), encoded as moveBefore.
    const moveOps = body.draftConfig.arms[1].ops;
    expect(moveOps.moveBefore).toBeDefined();
    expect(moveOps.moveAfter).toBeUndefined();
    expect(resolveLocatorOne(moveOps.moveBefore, document)).toBe(one);
    expect(resolveLocatorOne(body.target, document)).toBe(two);
  });

  it('Save posts a moveAfter draft anchored on the original next sibling', async () => {
    document.body.innerHTML = '<div id="root"><p id="one">One</p><p id="two">Two</p><p id="three">Three</p></div>';
    const fetchMock = await mountEditor();
    const two = document.getElementById('two')!;
    const three = document.getElementById('three')!;

    click(two);
    clickButton(getButton('Move down'));
    clickButton(getButton('Save this arrangement'));

    const isSlotCall = ([url]: unknown[]) => String(url).includes('/v1/editor/slots/');
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(isSlotCall)).toBe(true);
    });

    const call = fetchMock.mock.calls.find(isSlotCall)!;
    expect(String(call[0])).toMatch(/\/v1\/editor\/slots\/move-/);
    const init = call[1] as RequestInit;
    const body = JSON.parse(init.body as string);

    // 'two' moved to last position → resting anchor is its current previous
    // sibling ('three'), encoded as moveAfter.
    const moveOps = body.draftConfig.arms[1].ops;
    expect(moveOps.moveAfter).toBeDefined();
    expect(moveOps.moveBefore).toBeUndefined();
    expect(resolveLocatorOne(moveOps.moveAfter, document)).toBe(three);
    expect(resolveLocatorOne(body.target, document)).toBe(two);
  });
});

describe('buildStyleOps / styleFieldError', () => {
  it('rejects a unitless font size with field feedback and keeps it out of the ops', () => {
    const { style, errors } = buildStyleOps({ fontSize: '20' });
    expect(style.fontSize).toBeUndefined();
    expect(errors.fontSize).toBeTruthy();
    expect(errors.fontSize).toMatch(/unit/i);
  });

  it('accepts valid values (unit on sizes, keyword alignment, hex colour)', () => {
    const { style, errors } = buildStyleOps({
      fontSize: '20px', borderRadius: '1.5rem', fontWeight: '700',
      textAlign: 'center', color: '#1a1a1a',
    });
    expect(errors).toEqual({});
    expect(style).toEqual({
      fontSize: '20px', borderRadius: '1.5rem', fontWeight: '700',
      textAlign: 'center', color: '#1a1a1a',
    });
  });

  it('rejects an illegal alignment keyword and a non-colour', () => {
    expect(styleFieldError('textAlign', 'centre')).toMatch(/left|center/i);
    expect(styleFieldError('color', 'reddish')).toMatch(/colour|#/i);
    expect(styleFieldError('textAlign', 'center')).toBeNull();
    expect(styleFieldError('color', '#0af')).toBeNull();
  });

  it('skips empty fields without an error (no change requested)', () => {
    const { style, errors } = buildStyleOps({ fontSize: '', color: '   ' });
    expect(style).toEqual({});
    expect(errors).toEqual({});
  });
});

// Shared mount helpers for the DOM-driven editor tests below (mirrors the
// Move up/Move down describe's helpers — jsdom document persists across tests,
// so each mount adds a capture-phase listener; invoke button onclicks directly).
function makeEditorHelpers() {
  const getButton = (text: string): HTMLButtonElement => {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('#sentient-editor-panel button'));
    const btn = buttons.find((b) => b.textContent === text);
    if (!btn) throw new Error(`button not found: ${text}`);
    return btn;
  };
  const click = (node: Element): void => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const clickButton = (btn: HTMLButtonElement): void => {
    (btn.onclick as ((ev: Event) => unknown) | null)?.call(btn, new MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const mountEditor = async (): Promise<ReturnType<typeof vi.fn>> => {
    (window as unknown as { __sentientEditor: { token: string; apiBase: string } }).__sentientEditor = {
      token: 'tok', apiBase: 'https://api.example.com',
    };
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/editor/verify')) return new Response(JSON.stringify({ projectId: 'p1' }), { status: 200 });
      if (url.endsWith('/v1/editor/targets')) return new Response(JSON.stringify({ targets: [] }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await import('./index');
    await vi.waitFor(() => { expect(document.getElementById('sentient-editor-panel')).not.toBeNull(); });
    return fetchMock;
  };
  return { getButton, click, clickButton, mountEditor };
}

describe('editor panel: text-test leaf guard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.resetModules();
    delete (window as unknown as { __sentientEditor?: unknown }).__sentientEditor;
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('disables the text test (with an explanatory title) for a container that has child elements', async () => {
    const { getButton, click, mountEditor } = makeEditorHelpers();
    document.body.innerHTML = '<h1 id="hero">Get <span>started</span></h1>';
    await mountEditor();

    click(document.getElementById('hero')!); // uniquely targetable, but has a child <span>
    const textBtn = getButton('Test different text here');
    expect(textBtn.disabled).toBe(true);
    expect(textBtn.title).toMatch(/contains other elements/i);
    // Style and goal stay available — they don't flatten child markup.
    expect(getButton('Change style').disabled).toBe(false);
  });

  it('enables the text test for a leaf (text-only) element', async () => {
    const { getButton, click, mountEditor } = makeEditorHelpers();
    document.body.innerHTML = '<a id="cta">Book a demo</a>';
    await mountEditor();

    click(document.getElementById('cta')!);
    const textBtn = getButton('Test different text here');
    expect(textBtn.disabled).toBe(false);
    expect(textBtn.title).toBe('');
  });
});

describe('editor panel: style validation feedback', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.resetModules();
    delete (window as unknown as { __sentientEditor?: unknown }).__sentientEditor;
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('rejects a unitless font size with inline field feedback and does NOT save', async () => {
    const { getButton, click, clickButton, mountEditor } = makeEditorHelpers();
    document.body.innerHTML = '<a id="cta">Book</a>';
    const fetchMock = await mountEditor();

    click(document.getElementById('cta')!);
    clickButton(getButton('Change style'));
    const fontSize = document.querySelector<HTMLInputElement>('#sentient-editor-panel input[data-field="fontSize"]')!;
    fontSize.value = '20'; // no unit
    clickButton(getButton('Save draft'));

    const feedback = document.querySelector<HTMLElement>('#sentient-editor-panel [data-feedback="fontSize"]')!;
    expect(feedback.style.display).toBe('block');
    expect(feedback.textContent).toMatch(/unit/i);
    // No slot save call was made — the false "✓ Saved" is gone.
    const slotCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/v1/editor/slots/'));
    expect(slotCalls.length).toBe(0);
  });

  it('saves a slot draft when the font size has a valid unit', async () => {
    const { getButton, click, clickButton, mountEditor } = makeEditorHelpers();
    document.body.innerHTML = '<a id="cta">Book</a>';
    const fetchMock = await mountEditor();

    click(document.getElementById('cta')!);
    clickButton(getButton('Change style'));
    const fontSize = document.querySelector<HTMLInputElement>('#sentient-editor-panel input[data-field="fontSize"]')!;
    fontSize.value = '20px';
    clickButton(getButton('Save draft'));

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/v1/editor/slots/'))).toBe(true);
    });
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/v1/editor/slots/'))!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.draftConfig.arms[1].ops.style).toEqual({ fontSize: '20px' });
  });
});

describe('editor panel: teardown clears the token + injected meta', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.querySelectorAll('meta[data-sentient-editor]').forEach((m) => m.remove());
    vi.resetModules();
    delete (window as unknown as { __sentientEditor?: unknown }).__sentientEditor;
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('nulls window.__sentientEditor and removes the referrer meta on close', async () => {
    const { getButton, clickButton, mountEditor } = makeEditorHelpers();
    document.body.innerHTML = '<a id="cta">Book</a>';
    // Simulate the meta the snippet injects alongside the editor bundle.
    const meta = document.createElement('meta');
    meta.setAttribute('data-sentient-editor', '');
    meta.setAttribute('name', 'referrer');
    document.head.appendChild(meta);
    await mountEditor();
    expect((window as unknown as { __sentientEditor?: unknown }).__sentientEditor).not.toBeNull();

    clickButton(getButton('Close editor'));

    expect((window as unknown as { __sentientEditor?: unknown }).__sentientEditor).toBeNull();
    expect(document.querySelector('meta[data-sentient-editor]')).toBeNull();
  });
});

describe('editor panel: token expiry mid-session', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.resetModules();
    delete (window as unknown as { __sentientEditor?: unknown }).__sentientEditor;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports "session expired" (not "try again") when a save returns 401 mid-session', async () => {
    document.body.innerHTML = '<h1 id="hero">Headline</h1>';
    (window as unknown as { __sentientEditor: { token: string; apiBase: string } }).__sentientEditor = {
      token: 'tok', apiBase: 'https://api.example.com',
    };
    // verify + targets succeed (the session was valid on open); the POST save 401s
    // because the token expired while the user was editing.
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/editor/verify')) return new Response(JSON.stringify({ projectId: 'p1' }), { status: 200 });
      if (url.endsWith('/v1/editor/targets')) return new Response(JSON.stringify({ targets: [] }), { status: 200 });
      return new Response('unauthorized', { status: 401 });
    }));

    await import('./index');
    await vi.waitFor(() => {
      expect(document.getElementById('sentient-editor-panel')).not.toBeNull();
    });

    // Select the headline, open the in-panel text form, fill it, and save.
    // Invoke handlers directly (not .click()): earlier tests in this file leave
    // capture-phase document listeners attached whose stopPropagation would kill a
    // real dispatched click before it reached the button.
    document.getElementById('hero')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const findBtn = (label: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('#sentient-editor-panel button'))
        .find((b) => b.textContent === label)!;
    const invoke = (btn: HTMLButtonElement) =>
      (btn.onclick as ((ev: Event) => unknown) | null)?.call(btn, new MouseEvent('click'));
    invoke(findBtn('Test different text here'));
    const alt = document.querySelector<HTMLInputElement>('#sentient-editor-panel input[data-field="alt"]')!;
    alt.value = 'New wording';
    invoke(findBtn('Save draft'));

    await vi.waitFor(() => {
      expect(document.getElementById('sentient-editor-panel')!.textContent ?? '').toContain('session expired');
    });
    const panelText = document.getElementById('sentient-editor-panel')!.textContent ?? '';
    expect(panelText).not.toContain('try again'); // must not tell them to retry a dead token
  });
});
