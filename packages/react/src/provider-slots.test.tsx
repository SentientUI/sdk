import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { init } from '@sentientui/core';

vi.mock('@sentientui/core', () => ({
  init: vi.fn(() => ({ dispose: vi.fn(), destroy: vi.fn(), fetchWeights: vi.fn().mockResolvedValue([]) })),
  detectDeviceClass: () => 'desktop',
  detectTrafficSource: () => 'direct',
}));
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe('AdaptiveProvider slot/persona plumbing', () => {
  it('forwards initialSlots and initialPersona into core init()', () => {
    render(
      createElement(AdaptiveProvider, {
      enableGraph: false,
        apiKey: 'pk_test',
        context: 'saas',
        consent: true,
        initialSlots: { hero: { tone: 'urgent' } },
        initialPersona: { persona: 'buyer', confidence: 0.8 },
        children: null,
      } as never),
    );
    expect(vi.mocked(init)).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSlots: { hero: { tone: 'urgent' } },
        initialPersona: { persona: 'buyer', confidence: 0.8 },
      }),
    );
  });

  it('exposes apiBaseUrl through context (default and explicit)', async () => {
    const { useAdaptiveApiBaseUrl } = await import('./provider.js');
    const { renderHook } = await import('@testing-library/react');
    const { createElement: h } = await import('react');

    const defaultHook = renderHook(() => useAdaptiveApiBaseUrl(), {
      wrapper: ({ children }) =>
        h(AdaptiveProvider, { enableGraph: false, apiKey: 'pk_test', context: 'saas', consent: true, children } as never),
    });
    expect(defaultHook.result.current).toBe('https://api.sentient-ui.com/v1');

    const customHook = renderHook(() => useAdaptiveApiBaseUrl(), {
      wrapper: ({ children }) =>
        h(AdaptiveProvider, {
          apiKey: 'pk_test',
          context: 'saas',
          consent: true,
          apiBaseUrl: 'https://api.example.com/v1',
          children,
        } as never),
    });
    expect(customHook.result.current).toBe('https://api.example.com/v1');
  });
});
