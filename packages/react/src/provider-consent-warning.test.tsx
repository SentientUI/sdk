import { render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentientui/core', () => ({ init: vi.fn(() => null), reveal: vi.fn() }));
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn() }));

// Audit S6: tracking is default-on, so an install with no consent gate tracks
// every visitor from first paint. Development builds say so, once.
afterEach(() => vi.restoreAllMocks());

async function freshProvider() {
  vi.resetModules();
  return (await import('./provider.js')).AdaptiveProvider;
}

describe('no-consent-gate dev warning', () => {
  it('warns once when neither consent nor consentFrom is set', async () => {
    const AdaptiveProvider = await freshProvider();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(createElement(AdaptiveProvider, { apiKey: 'pk_test_x', enableGraph: false, children: null }));
    render(createElement(AdaptiveProvider, { apiKey: 'pk_test_x', enableGraph: false, children: null }));
    const hits = warn.mock.calls.filter((c) => String(c[0]).includes('No consent gate'));
    expect(hits).toHaveLength(1);
    expect(String(hits[0]![0])).toContain('consentFrom=');
    expect(String(hits[0]![0])).toContain('docs#consent');
  });

  it('is silent when either is set', async () => {
    for (const props of [{ consent: true }, { consent: false }, { consentFrom: 'onetrust' as const }]) {
      const AdaptiveProvider = await freshProvider();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      render(createElement(AdaptiveProvider, { apiKey: 'pk_test_x', enableGraph: false, ...props, children: null }));
      expect(warn.mock.calls.some((c) => String(c[0]).includes('No consent gate'))).toBe(false);
      warn.mockRestore();
    }
  });
});
