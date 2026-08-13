import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Preview mode: ?sentient_preview=<slotId>[&sentient_arm=<armId>] on an
// editor-token link renders the component with that variant's ops injected and
// a floating bar (variant chips + Exit) instead of the picker panel.

const PANEL_ID = 'sentient-editor-panel';
const BAR_ID = 'sentient-preview-bar';

const SLOT_ROW = {
  slot_id: 'btn-test',
  kind: 'arms',
  target: { v: 1, selector: '.btn' },
  display_name: 'Button test',
  status: 'draft',
  draft_config: {
    arms: [
      { id: 'a', displayName: 'Original', ops: { text: 'Get started' } },
      { id: 'b', displayName: 'Alternative', ops: { text: 'Start free' } },
    ],
  },
  published_config: null,
};

function setUrl(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
}

async function mountPreviewEditor(opts: { slots?: unknown[]; search: string }): Promise<void> {
  setUrl(opts.search);
  (window as unknown as { __sentientEditor: { token: string; apiBase: string } }).__sentientEditor = {
    token: 'tok', apiBase: 'https://api.example.com',
  };
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/v1/editor/verify')) {
      return new Response(JSON.stringify({ projectId: 'p1' }), { status: 200 });
    }
    if (url.endsWith('/v1/editor/slots')) {
      return new Response(JSON.stringify({ slots: opts.slots ?? [SLOT_ROW] }), { status: 200 });
    }
    if (url.endsWith('/v1/editor/targets')) {
      return new Response(JSON.stringify({ targets: [], fonts: [] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  await import('./index');
  await vi.waitFor(() => {
    expect(document.getElementById(BAR_ID)).not.toBeNull();
  });
}

describe('editor preview mode', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.resetModules();
    delete (window as unknown as { __sentientEditor?: unknown }).__sentientEditor;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setUrl('');
  });

  it('applies the requested arm ops to the resolved element and shows the bar', async () => {
    document.body.innerHTML = '<button class="btn">Get started</button>';
    await mountPreviewEditor({ search: '?sentient_preview=btn-test&sentient_arm=b' });
    expect(document.querySelector('.btn')!.textContent).toBe('Start free');
    const bar = document.getElementById(BAR_ID)!;
    expect(bar.textContent).toContain('Button test');
    expect(bar.textContent).toContain('Alternative');
    expect(bar.textContent).toContain('Exit preview');
  });

  it('defaults to the first non-original arm when sentient_arm is absent', async () => {
    document.body.innerHTML = '<button class="btn">Get started</button>';
    await mountPreviewEditor({ search: '?sentient_preview=btn-test' });
    expect(document.querySelector('.btn')!.textContent).toBe('Start free');
  });

  it('does not mount the picker panel in preview mode', async () => {
    document.body.innerHTML = '<button class="btn">Get started</button>';
    await mountPreviewEditor({ search: '?sentient_preview=btn-test' });
    expect(document.getElementById(PANEL_ID)).toBeNull();
  });

  it('shows a not-found message when the locator does not resolve on this page', async () => {
    document.body.innerHTML = '<p>nothing to see</p>';
    await mountPreviewEditor({ search: '?sentient_preview=btn-test' });
    expect(document.getElementById(BAR_ID)!.textContent).toMatch(/couldn.t find this component/i);
  });

  it('falls back to the published config when there is no draft', async () => {
    document.body.innerHTML = '<button class="btn">Get started</button>';
    await mountPreviewEditor({
      search: '?sentient_preview=btn-test&sentient_arm=b',
      slots: [{ ...SLOT_ROW, draft_config: null, published_config: SLOT_ROW.draft_config }],
    });
    expect(document.querySelector('.btn')!.textContent).toBe('Start free');
  });

  it('shows a load-failure message for an unknown slot', async () => {
    document.body.innerHTML = '<button class="btn">Get started</button>';
    await mountPreviewEditor({ search: '?sentient_preview=ghost', slots: [SLOT_ROW] });
    expect(document.getElementById(BAR_ID)!.textContent).toMatch(/couldn.t load this preview/i);
  });
});
