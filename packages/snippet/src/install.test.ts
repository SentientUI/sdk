import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  renderSnippetInstall,
  renderSnippetPrePaintScript,
  serializeSnippetConfig,
  SNIPPET_LOADER_URL,
  type PrePaintRecord,
} from './install';

const KEY = 'pk_test_abc';

/** The inline <script> bodies, in document order, plus the external srcs. */
function parseTags(html: string): { inline: string[]; src: Array<{ src: string; defer: boolean }> } {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><head>${html}</head><body></body></html>`, 'text/html');
  const scripts = Array.from(doc.head.querySelectorAll('script'));
  return {
    inline: scripts.filter((s) => !s.src).map((s) => s.textContent ?? ''),
    src: scripts.filter((s) => s.getAttribute('src')).map((s) => ({ src: s.getAttribute('src')!, defer: s.hasAttribute('defer') })),
  };
}

describe('renderSnippetInstall — two-tag default', () => {
  const html = renderSnippetInstall({ config: { apiKey: KEY } });

  it('is exactly two tags: combined config + pre-paint, then the deferred loader', () => {
    const { inline, src } = parseTags(html);
    expect(inline).toHaveLength(1);
    expect(src).toEqual([{ src: SNIPPET_LOADER_URL, defer: true }]);
    // Config first inside the tag, pre-paint after it.
    expect(inline[0]!.startsWith(`window.sentient = {"apiKey":"${KEY}"};`)).toBe(true);
    expect(inline[0]!.endsWith(renderSnippetPrePaintScript())).toBe(true);
    // Loader last in the markup.
    expect(html.trimEnd().endsWith('defer></script>')).toBe(true);
    expect(html.indexOf('snippet.global.js')).toBeGreaterThan(html.indexOf('(function(){'));
  });

  it('the pre-paint script sees the config assigned earlier in the SAME tag', () => {
    // The whole premise of folding: the script reads window.sentient at run
    // time. Run the combined body as one script and check the hand-off record.
    localStorage.setItem(
      `_snt_snap:${KEY}`,
      JSON.stringify({ v: 1, persona: 'admin', band: 'high', slots: {}, layoutOrder: null, savedAt: Date.now() }),
    );
    try {
      (0, eval)(parseTags(html).inline[0]!);
      const pp = (window as unknown as { __sntPP?: PrePaintRecord }).__sntPP;
      expect(pp?.v).toBe(1); // what the bundle reports as `pp` — unaffected by folding
      expect((window as unknown as { sentient?: { apiKey: string } }).sentient?.apiKey).toBe(KEY);
    } finally {
      (window as unknown as { __sntPP?: PrePaintRecord }).__sntPP?.stop();
      delete (window as unknown as { __sntPP?: unknown }).__sntPP;
      delete (window as unknown as { sentient?: unknown }).sentient;
      localStorage.clear();
    }
  });

  it('honours a pinned loaderSrc', () => {
    const pinned = 'https://unpkg.com/@sentientui/snippet@1.2.3/dist/snippet.global.js';
    expect(parseTags(renderSnippetInstall({ config: { apiKey: KEY }, loaderSrc: pinned })).src).toEqual([
      { src: pinned, defer: true },
    ]);
  });
});

describe('renderSnippetInstall — split (strict CSP)', () => {
  const html = renderSnippetInstall({ config: { apiKey: KEY }, split: true });

  it('is config, pre-paint, loader — in that order', () => {
    const { inline, src } = parseTags(html);
    expect(inline).toEqual([`window.sentient = {"apiKey":"${KEY}"};`, renderSnippetPrePaintScript()]);
    expect(src).toEqual([{ src: SNIPPET_LOADER_URL, defer: true }]);
    expect(html.indexOf('window.sentient')).toBeLessThan(html.indexOf('(function(){'));
    expect(html.indexOf('(function(){')).toBeLessThan(html.indexOf('snippet.global.js'));
  });

  it('the pre-paint tag is byte-identical across sites (one CSP hash covers all)', () => {
    const other = renderSnippetInstall({ config: { apiKey: 'pk_other', personaAttributes: true }, split: true });
    expect(parseTags(other).inline[1]).toBe(parseTags(html).inline[1]);
    // …which is exactly what the combined form cannot offer.
    expect(parseTags(renderSnippetInstall({ config: { apiKey: 'pk_other' } })).inline[0]).not.toBe(
      parseTags(renderSnippetInstall({ config: { apiKey: KEY } })).inline[0],
    );
  });
});

describe('serializeSnippetConfig — inline-HTML safety', () => {
  const hostile = { apiKey: KEY, note: '</script><script>alert(1)</script><!-- x -->', ls: 'a\u2028b\u2029c' };

  it('never emits a raw `<`, `>`, U+2028 or U+2029', () => {
    const s = serializeSnippetConfig(hostile);
    expect(s).not.toMatch(/[<>\u2028\u2029]/);
  });

  it('round-trips to the same config', () => {
    expect(JSON.parse(serializeSnippetConfig(hostile))).toEqual(hostile);
    expect((0, eval)(`(${serializeSnippetConfig(hostile)})`)).toEqual(hostile);
  });

  it('a hostile value cannot break out of the combined tag', () => {
    for (const split of [false, true]) {
      const { inline, src } = parseTags(renderSnippetInstall({ config: hostile, split }));
      expect(inline).toHaveLength(split ? 2 : 1);
      expect(src).toHaveLength(1);
      expect(() => new Function(inline[0]!)).not.toThrow();
    }
  });

  it('escapes the loader src attribute', () => {
    const html = renderSnippetInstall({ config: { apiKey: KEY }, loaderSrc: 'https://x.test/a"><script>b' });
    expect(parseTags(html).src).toHaveLength(1);
  });
});

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());
