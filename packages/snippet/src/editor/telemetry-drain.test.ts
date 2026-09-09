// @vitest-environment jsdom
// Own file, ONE mount: flushTelemetry is exercised via window 'pagehide', and
// every mount in a shared test file leaves its own pagehide listener attached —
// dispatching the event there flushes all of them, drowning the assertion.
import { describe, it, expect, vi } from 'vitest';
import { mount } from './index';

describe('telemetry drain', () => {
  it('flushTelemetry drains the whole queue in 20-event batches (nothing stranded at pagehide)', () => {
    document.body.innerHTML = '<h1 id="hero">Welcome</h1>';
    const fetchMock = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mount({ token: 'tok', apiBase: 'https://api.example.com' });
    // 25 selections → 25 element_selected + 25 form_opened (the text form
    // auto-opens for an eligible leaf), plus editor_opened = 51 events.
    for (let i = 0; i < 25; i++) {
      document.getElementById('hero')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    window.dispatchEvent(new Event('pagehide'));
    const telemetry = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/v1/editor/telemetry'));
    // One splice(0, 20) used to send a single batch and strand events 21+ —
    // permanently when the flush was the pagehide one.
    const sizes = telemetry.map((c) => (JSON.parse((c[1] as RequestInit).body as string).events as unknown[]).length);
    expect(telemetry.length).toBe(3);
    expect(sizes.every((s) => s <= 20)).toBe(true); // the server-enforced batch cap
    expect(sizes.reduce((a, s) => a + s, 0)).toBe(51); // nothing stranded
  });
});
