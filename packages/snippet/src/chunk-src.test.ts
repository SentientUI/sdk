import { afterEach, describe, expect, it, vi } from 'vitest';

// Audit S4: a version-pinned, SRI-protected loader fetched its lazy chunks
// with no integrity. Unstamped builds (tests, dev) must never send a hash.

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.resetModules();
});

const tag = (src: string) => {
  const s = document.createElement('script');
  s.src = src;
  document.body.appendChild(s);
};

describe('chunkSrc', () => {
  it('derives the chunk beside the snippet, with integrity only when pinned and stamped', async () => {
    vi.stubGlobal('__CONSENT_SRI__', 'sha384-abc');
    vi.stubGlobal('__EDITOR_SRI__', 'sha384-def');
    const { chunkSrc } = await import('./chunk-src');
    tag('https://unpkg.com/@sentientui/snippet@0.32.0/dist/snippet.global.js');
    expect(chunkSrc('consent.global.js')).toEqual({
      src: 'https://unpkg.com/@sentientui/snippet@0.32.0/dist/consent.global.js',
      integrity: 'sha384-abc',
    });
    expect(chunkSrc('editor.global.js')?.integrity).toBe('sha384-def');
  });

  it('an unpinned (latest) loader gets no integrity — the chunk may be a newer release', async () => {
    vi.stubGlobal('__CONSENT_SRI__', 'sha384-abc');
    const { chunkSrc } = await import('./chunk-src');
    tag('https://unpkg.com/@sentientui/snippet/dist/snippet.global.js');
    expect(chunkSrc('consent.global.js')).toEqual({ src: 'https://unpkg.com/@sentientui/snippet/dist/consent.global.js' });
  });

  it('an unstamped placeholder is never used as a hash', async () => {
    vi.stubGlobal('__CONSENT_SRI__', '__SNT_SRI_CONSENT__');
    const { chunkSrc } = await import('./chunk-src');
    tag('https://unpkg.com/@sentientui/snippet@0.32.0/dist/snippet.global.js');
    expect(chunkSrc('consent.global.js')?.integrity).toBeUndefined();
  });

  it('setChunkSrc sets integrity with CORS mode', async () => {
    const { setChunkSrc } = await import('./chunk-src');
    const s = document.createElement('script');
    setChunkSrc(s, { src: 'https://x.example/c.js', integrity: 'sha384-z' });
    expect(s.integrity).toBe('sha384-z');
    expect(s.crossOrigin).toBe('anonymous');
    expect(s.src).toBe('https://x.example/c.js');
  });
});

describe('chunkSrc — renamed or self-hosted loader (review M1)', () => {
  it('falls back to the script that booted the bundle', async () => {
    const boot = document.createElement('script');
    boot.src = 'https://shop.example/assets/sentient.3f2a.js?v=2';
    Object.defineProperty(document, 'currentScript', { configurable: true, get: () => boot });
    try {
      const { chunkSrc } = await import('./chunk-src');
      expect(chunkSrc('consent.global.js')).toEqual({ src: 'https://shop.example/assets/consent.global.js' });
    } finally {
      delete (document as unknown as { currentScript?: unknown }).currentScript;
    }
  });

  it('matches a .min.js loader too', async () => {
    const { chunkSrc } = await import('./chunk-src');
    tag('https://cdn.jsdelivr.net/npm/@sentientui/snippet@0.32.0/dist/snippet.global.min.js');
    expect(chunkSrc('consent.global.js')?.src).toBe('https://cdn.jsdelivr.net/npm/@sentientui/snippet@0.32.0/dist/consent.global.js');
  });
});

describe('chunkSrc — another vendor\'s snippet.js on the page (review M1)', () => {
  it('uses the script that booted the SDK, not the first snippet.js found', async () => {
    tag('https://static.zdassets.com/ekr/snippet.js?key=abc'); // Zendesk, earlier in the DOM
    const boot = document.createElement('script');
    boot.src = 'https://unpkg.com/@sentientui/snippet/dist/snippet.global.js';
    document.body.appendChild(boot);
    Object.defineProperty(document, 'currentScript', { configurable: true, get: () => boot });
    try {
      const { chunkSrc } = await import('./chunk-src');
      expect(chunkSrc('consent.global.js')?.src).toBe('https://unpkg.com/@sentientui/snippet/dist/consent.global.js');
    } finally {
      delete (document as unknown as { currentScript?: unknown }).currentScript;
    }
  });
});
