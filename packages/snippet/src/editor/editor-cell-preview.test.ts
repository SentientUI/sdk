import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// "Preview on your site" for a generated version (sentient_preview_cell): a
// redesigned section must render with the site's own class lists, which the
// preview response carries — the decision that normally ships them never ran.

const BAR_ID = 'sentient-preview-bar';
const at = '2026-09-20T00:00:00.000Z';
const entry = (id: string, role: string, classes: string) => ({ id, role, classes, computed: {}, seen: { url: '/', count: 1, at }, source: 'editor' });

async function boot(preview: Record<string, unknown>): Promise<void> {
  window.history.replaceState({}, '', '/?sentient_preview_cell=hero~unknown');
  (window as unknown as { __sentientEditor: { token: string; apiBase: string } }).__sentientEditor = { token: 'tok', apiBase: 'https://api.example.com' };
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/v1/editor/verify')) return new Response(JSON.stringify({ projectId: 'p1' }), { status: 200 });
    if (url.includes('/v1/editor/cell-preview')) return new Response(JSON.stringify(preview), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
  await import('./index');
  await vi.waitFor(() => expect(document.getElementById(BAR_ID)).not.toBeNull());
}

describe('on-site preview of a redesigned section (snippet)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<section id="hero"><h2>Crash repairs done right</h2><a href="/contact">Get in touch</a></section>';
    vi.resetModules();
    delete (window as unknown as { __sentientEditor?: unknown }).__sentientEditor;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
  });

  it('renders the composed section with the borrowed site classes, in place', async () => {
    await boot({
      status: 'review', slotName: 'Home hero', personaDisplay: 'everyone', content: null, blocks: null,
      target: { v: 1, selector: '#hero' },
      compose: { surface: { like: 'section' }, tree: { type: 'button', label: 'Get a quote', href: '/quote', like: 'button-primary' } },
      vocabulary: { rev: 'r', images: [], entries: [entry('section', 'section', 'bg-slate-900 py-24'), entry('button-primary', 'button-primary', 'btn btn-blue')] },
    });
    const hero = document.getElementById('hero')!;
    const button = hero.querySelector('.btn-blue');
    expect(button?.textContent).toBe('Get a quote');
    expect(hero.querySelector('.bg-slate-900')).not.toBeNull();
    expect(document.getElementById(BAR_ID)!.textContent).toContain('Home hero');
  });

  it('a dropped style falls back to palette styling rather than failing the preview', async () => {
    await boot({
      status: 'live', slotName: 'Home hero', personaDisplay: 'everyone', content: null, blocks: null,
      target: { v: 1, selector: '#hero' },
      compose: { tree: { type: 'button', label: 'Get a quote', href: '/quote', like: 'button-primary' } },
      vocabulary: { rev: 'r', images: [], entries: [] },
    });
    expect(document.getElementById('hero')!.textContent).toContain('Get a quote');
  });
});
