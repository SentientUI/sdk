import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachSlotSignals } from './slot-signals';

// jsdom has no IntersectionObserver; the scroll-hesitation detector needs one.
class IOStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', IOStub);
  document.body.innerHTML = '<a id="cta">Get started</a>';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function makeClient() {
  return { track: vi.fn() };
}

const applied = () => [{ slotId: 'hero-cta', arm: 'b', el: document.getElementById('cta')! }];

describe('attachSlotSignals', () => {
  it('tags rage clicks with the slot and arm', () => {
    const client = makeClient();
    attachSlotSignals(client, 'pk_test', applied());
    const el = document.getElementById('cta')!;
    for (let i = 0; i < 3; i++) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(client.track).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'pk_test',
      componentId: 'hero-cta',
      variantId: 'b',
      eventType: 'micro_signal',
      payload: expect.objectContaining({ signalType: 'rage_click' }),
    }));
  });

  it('emits a cursor_signal after an 800ms hover, tagged with slot and arm', () => {
    vi.useFakeTimers();
    const client = makeClient();
    attachSlotSignals(client, 'pk_test', applied());
    const el = document.getElementById('cta')!;
    el.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(900);
    expect(client.track).toHaveBeenCalledWith(expect.objectContaining({
      componentId: 'hero-cta',
      variantId: 'b',
      eventType: 'cursor_signal',
      payload: expect.objectContaining({ hoverDuration: expect.any(Number) }),
    }));
  });

  it('does not emit cursor_signal for a hover shorter than 800ms', () => {
    vi.useFakeTimers();
    const client = makeClient();
    attachSlotSignals(client, 'pk_test', applied());
    const el = document.getElementById('cta')!;
    el.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(400);
    el.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(1000);
    expect(client.track).not.toHaveBeenCalled();
  });

  it('cleanup detaches all listeners', () => {
    const client = makeClient();
    const cleanup = attachSlotSignals(client, 'pk_test', applied());
    cleanup();
    const el = document.getElementById('cta')!;
    for (let i = 0; i < 3; i++) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(client.track).not.toHaveBeenCalled();
  });
});
