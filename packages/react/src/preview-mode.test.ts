import { describe, expect, it, vi } from 'vitest';
import { setPreviewMode, getPreviewMode, subscribePreview, createPreviewClient } from './preview-mode';
import type { SentientClient } from '@sentientui/core';

function fakeClient(): SentientClient {
  return {
    track: vi.fn(), goal: vi.fn(), componentGoal: vi.fn(), identify: vi.fn(),
    getAssignment: vi.fn(() => ({ variantId: 'a', content: null })),
    assign: vi.fn(async () => null), fetchWeights: vi.fn(async () => []),
    getGraph: vi.fn(() => ({ pageNodes: [], capturedAt: 0 })), dispose: vi.fn(), destroy: vi.fn(),
  } as unknown as SentientClient;
}

describe('preview-mode', () => {
  it('toggles and notifies', () => {
    const spy = vi.fn();
    const unsub = subscribePreview(spy);
    setPreviewMode(true);
    expect(getPreviewMode()).toBe(true);
    expect(spy).toHaveBeenCalled();
    setPreviewMode(false);
    unsub();
  });

  it('preview client suppresses all emitters but keeps reads', () => {
    const inner = fakeClient();
    const p = createPreviewClient(inner);
    p.track({} as never); p.goal('g'); p.componentGoal('c', 'click'); p.identify('u');
    expect(inner.track).not.toHaveBeenCalled();
    expect(inner.goal).not.toHaveBeenCalled();
    expect(inner.componentGoal).not.toHaveBeenCalled();
    expect(inner.identify).not.toHaveBeenCalled();
    expect(p.getAssignment('c', 's')).toEqual({ variantId: 'a', content: null });
    expect(inner.getAssignment).toHaveBeenCalled();
  });
});
