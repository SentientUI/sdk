import { render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { init } from '@sentientui/core';

vi.mock('@sentientui/core', () => ({
  reveal: vi.fn(),
  init: vi.fn(),
  attachMicroSignalDetectors: vi.fn(() => () => undefined),
}));
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn() }));
vi.mock('./segment.js', () => ({ detectSegment: () => 'desktop:direct' }));

function makeClient() {
  return {
    getAssignment: vi.fn().mockReturnValue(null),
    assign: vi.fn().mockResolvedValue(null),
    destroy: vi.fn(), flush: vi.fn(), dispose: vi.fn(),
    track: vi.fn(), goal: vi.fn(), componentGoal: vi.fn(), identify: vi.fn(),
    getGraph: vi.fn().mockReturnValue({ pageNodes: [], capturedAt: 0 }),
    fetchWeights: vi.fn().mockResolvedValue([]),
    decide: vi.fn().mockResolvedValue(null),
    getSlotResult: vi.fn().mockReturnValue(null),
    getSlotConfig: vi.fn().mockReturnValue(null),
    getSitePalette: vi.fn().mockReturnValue(null),
    reportSlots: vi.fn(),
    getPersona: vi.fn().mockReturnValue(null),
  };
}

beforeEach(() => vi.clearAllMocks());

const props = (identity?: { userId: string; userHash?: string }) => ({
  enableGraph: false, apiKey: 'pk_test_key_1234', context: 'saas' as const, consent: true, identity, children: null,
});

describe('AdaptiveProvider identity', () => {
  it('identifies once with the signed hash, and not again on a re-render', async () => {
    const client = makeClient();
    vi.mocked(init).mockReturnValue(client as unknown as ReturnType<typeof init>);
    const { rerender } = render(createElement(AdaptiveProvider, props({ userId: 'user_42', userHash: 'v1.abc' })));
    await waitFor(() => expect(client.identify).toHaveBeenCalledTimes(1));
    expect(client.identify).toHaveBeenCalledWith('user_42', { userHash: 'v1.abc' });
    rerender(createElement(AdaptiveProvider, props({ userId: 'user_42', userHash: 'v1.abc' })));
    expect(client.identify).toHaveBeenCalledTimes(1);
  });

  it('identifies nobody when signed out', async () => {
    const client = makeClient();
    vi.mocked(init).mockReturnValue(client as unknown as ReturnType<typeof init>);
    render(createElement(AdaptiveProvider, props()));
    await waitFor(() => expect(init).toHaveBeenCalled());
    expect(client.identify).not.toHaveBeenCalled();
  });
});
