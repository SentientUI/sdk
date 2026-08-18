import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { AdaptiveProvider } from './provider.js';
import { getRegisteredSections, registerSections } from './devtools-registry.js';
import { init } from '@sentientui/core';

vi.mock('@sentientui/core', () => ({ init: vi.fn() }));
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn() }));
vi.mock('./segment.js', () => ({ detectSegment: () => 'desktop:direct' }));

beforeEach(() => {
  registerSections([]);
  vi.mocked(init).mockReturnValue({
    getAssignment: vi.fn().mockReturnValue(null),
    assign: vi.fn().mockResolvedValue(null),
    destroy: vi.fn(),
    dispose: vi.fn(),
    track: vi.fn(),
    goal: vi.fn(),
    componentGoal: vi.fn(),
    identify: vi.fn(),
    getGraph: vi.fn().mockReturnValue({ pageNodes: [], capturedAt: 0 }),
    fetchWeights: vi.fn().mockResolvedValue([]),
  } as never);
});

const BASE = { enableGraph: false, apiKey: 'pk_test_key_1234', context: 'saas' as const, consent: true };

describe('section registry for devtools', () => {
  it('registers the decided order when there is one', () => {
    render(
      <AdaptiveProvider {...BASE} initialLayoutOrder={['faq', 'hero']} declaredSections={['hero', 'faq']}>
        <div />
      </AdaptiveProvider>,
    );
    // The decided order is what the page is actually rendering, so it wins.
    expect(getRegisteredSections()).toEqual(['faq', 'hero']);
  });

  it('falls back to the declared sections when no decision arrived', () => {
    // The case that matters: consent-gated or timed-out SSR leaves
    // initialLayoutOrder null, and the devtools layout panel was empty exactly
    // when you reach for it — running the site locally before accepting.
    render(
      <AdaptiveProvider {...BASE} initialLayoutOrder={null} declaredSections={['hero', 'pricing', 'faq']}>
        <div />
      </AdaptiveProvider>,
    );
    expect(getRegisteredSections()).toEqual(['hero', 'pricing', 'faq']);
  });

  it('registers nothing when the app declares no sections', () => {
    render(
      <AdaptiveProvider {...BASE}>
        <div />
      </AdaptiveProvider>,
    );
    expect(getRegisteredSections()).toEqual([]);
  });
});
