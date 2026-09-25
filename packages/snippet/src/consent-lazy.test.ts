import { afterEach, describe, expect, it, vi } from 'vitest';
import { consentWatcher as real } from '@sentientui/core/consent';
import { _resetConsentLazy, consentWatcher, setConsentSrc } from './consent-lazy';

const w = window as unknown as Record<string, unknown>;
afterEach(() => {
  _resetConsentLazy();
  delete w.__sentientConsent;
  delete w.Cookiebot;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('lazy consent presets', () => {
  it('reads unknown (gated) until the chunk loads, then notifies subscribers with the real answer', async () => {
    const tag = document.createElement('script');
    tag.src = 'https://cdn.example/@sentientui/snippet@1/dist/snippet.global.js';
    document.body.appendChild(tag);
    w.Cookiebot = { consent: { statistics: true } };

    const watcher = consentWatcher('cookiebot');
    expect(watcher.read()).toBeNull();
    const injected = document.head.querySelector('script') as HTMLScriptElement;
    expect(injected.src).toBe('https://cdn.example/@sentientui/snippet@1/dist/consent.global.js');

    const cb = vi.fn();
    const stop = watcher.subscribe(cb);
    expect(cb).not.toHaveBeenCalled();
    // A second watcher does not request the chunk twice.
    consentWatcher('onetrust');
    expect(document.head.querySelectorAll('script')).toHaveLength(1);

    w.__sentientConsent = { consentWatcher: real };
    injected.onload!(new Event('load'));
    await Promise.resolve();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledOnce();
    expect(watcher.read()).toBe(true);

    // Now wired to the real platform events.
    w.Cookiebot = { consent: { statistics: false } };
    window.dispatchEvent(new Event('CookiebotOnDecline'));
    expect(cb).toHaveBeenCalledTimes(2);
    expect(watcher.read()).toBe(false);
    stop();
    window.dispatchEvent(new Event('CookiebotOnAccept'));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('honours consentSrc, and a failed load stays gated', async () => {
    setConsentSrc('https://self.example/consent.js');
    const watcher = consentWatcher('cookiebot');
    const injected = document.head.querySelector('script') as HTMLScriptElement;
    expect(injected.src).toBe('https://self.example/consent.js');
    const cb = vi.fn();
    watcher.subscribe(cb);
    injected.onerror!(new Event('error'));
    await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();
    expect(watcher.read()).toBeNull();
  });

  it('uses an already-present chunk synchronously', () => {
    w.__sentientConsent = { consentWatcher: real };
    w.Cookiebot = { consent: { statistics: true } };
    expect(consentWatcher('cookiebot').read()).toBe(true);
    expect(document.head.querySelector('script')).toBeNull();
  });
});
