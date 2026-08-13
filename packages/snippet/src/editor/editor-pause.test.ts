import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Boot-level tests for the pause/resume toggle: while paused the capture-phase
// picker handlers must let clicks/hovers reach the site untouched.

const PANEL_ID = 'sentient-editor-panel';

function panelButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll(`#${PANEL_ID} button`));
}
function buttonByText(text: string): HTMLButtonElement {
  const btn = panelButtons().find((b) => b.textContent === text);
  if (!btn) throw new Error(`no panel button reading "${text}"`);
  return btn;
}

async function mountEditor(): Promise<void> {
  (window as unknown as { __sentientEditor: { token: string; apiBase: string } }).__sentientEditor = {
    token: 'tok', apiBase: 'https://api.example.com',
  };
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/v1/editor/verify')) {
      return new Response(JSON.stringify({ projectId: 'p1' }), { status: 200 });
    }
    if (url.endsWith('/v1/editor/targets')) {
      return new Response(JSON.stringify({ targets: [], fonts: [] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  await import('./index');
  await vi.waitFor(() => {
    expect(document.getElementById(PANEL_ID)).not.toBeNull();
  });
}

describe('editor pause', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.resetModules();
    delete (window as unknown as { __sentientEditor?: unknown }).__sentientEditor;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pausing lets clicks reach the page (no preventDefault, no selection)', async () => {
    await mountEditor();
    const pauseBtn = buttonByText('Pause selecting');
    pauseBtn.click();
    expect(pauseBtn.textContent).toBe('Resume selecting');
    expect(document.getElementById(PANEL_ID)!.textContent).toContain('Selection paused');

    const link = document.createElement('a');
    link.id = 'site-link';
    link.textContent = 'Menu';
    document.body.appendChild(link);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    // Nothing got selected — the "Selected:" label stays hidden.
    expect(document.getElementById(PANEL_ID)!.textContent).not.toContain('Selected:');
  });

  it('pausing hides the hover highlight and ignores mousemove', async () => {
    await mountEditor();
    buttonByText('Pause selecting').click();
    const el = document.createElement('h1');
    el.textContent = 'Hello';
    document.body.appendChild(el);
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    const highlight = document.getElementById('sentient-editor-highlight');
    expect(highlight?.style.display ?? 'none').toBe('none');
  });

  it('resuming restores element picking', async () => {
    await mountEditor();
    const pauseBtn = buttonByText('Pause selecting');
    pauseBtn.click();
    pauseBtn.click(); // resume
    expect(pauseBtn.textContent).toBe('Pause selecting');

    const target = document.createElement('button');
    target.textContent = 'Buy';
    target.id = 'buy-btn';
    document.body.appendChild(target);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true); // picker intercepts again
    expect(document.getElementById(PANEL_ID)!.textContent).toContain('Selected:');
  });
});
