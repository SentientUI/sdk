import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdaptiveDevtools } from './index';
import {
  registerComponent,
  registerSlot,
  registerSections,
} from '../devtools-registry';
import { getOverridesVersion } from '../override-events';
import { getOverrides } from '../devtools-overrides';
import { getPreviewMode, setPreviewMode } from '../preview-mode';
import { pickDeterministicArm } from '@sentientui/policy';

type W = Window & {
  __sentient_registry?: unknown;
  __sentient_preview?: unknown;
  __sentient_overrides?: Record<string, string>;
  __sentient_layout_override?: string[];
  __sentient_slot_overrides?: Record<string, string | Record<string, string>>;
  __sentient_devtools_config?: { apiKey: string; apiBaseUrl: string; isLocal: boolean };
};
const w = window as unknown as W;

beforeEach(() => {
  delete w.__sentient_registry;
  delete w.__sentient_preview;
  delete w.__sentient_overrides;
  delete w.__sentient_layout_override;
  delete w.__sentient_slot_overrides;
  delete w.__sentient_devtools_config;
  delete document.documentElement.dataset.sentientPersona;
  delete document.documentElement.dataset.sentientConfidence;
  document.cookie = '_snt_uid=; max-age=0; path=/';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function openPanel(): void {
  fireEvent.click(screen.getByRole('button', { name: /sentient devtools/i }));
}

describe('AdaptiveDevtools — variants (existing behavior preserved)', () => {
  it('lists registered components and forces a variant on click', () => {
    registerComponent({ id: 'hero_cta', variantIds: ['a', 'b'], goal: 'signup' });
    render(<AdaptiveDevtools />);
    openPanel();
    expect(screen.getByText(/hero_cta/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'b' }));
    expect(getOverrides().hero_cta).toBe('b');
    expect(getPreviewMode()).toBe(true);
    setPreviewMode(false);
  });
});

describe('AdaptiveDevtools — local mode', () => {
  it('shows the banner, forces a persona through the local engine, applies everything, never fetches', async () => {
    document.cookie = '_snt_uid=devtools-sess';
    w.__sentient_devtools_config = { apiKey: '', apiBaseUrl: 'https://api.example.com/v1', isLocal: true };
    registerComponent({ id: 'hero_cta', variantIds: ['a', 'b'] });
    registerSlot({ id: 'hero', dims: { tone: ['calm', 'urgent'] } });
    registerSlot({ id: 'pricing-area', arms: ['standard', 'social_first'] });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<AdaptiveDevtools />);
    openPanel();
    expect(screen.getByText('Local mode — decisions are simulated; add a key to learn from real traffic')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Buyer' }));
    await vi.waitFor(() =>
      expect(document.documentElement.dataset.sentientPersona).toBe('buyer'),
    );
    expect(document.documentElement.dataset.sentientConfidence).toBe('medium');
    expect(w.__sentient_slot_overrides?.hero).toEqual({
      tone: pickDeterministicArm('devtools-sess:buyer', 'hero.tone', ['calm', 'urgent']),
    });
    expect(w.__sentient_slot_overrides?.['pricing-area']).toBe(
      pickDeterministicArm('devtools-sess:buyer', 'pricing-area', ['standard', 'social_first']),
    );
    expect(getOverrides().hero_cta).toBe(pickDeterministicArm('devtools-sess', 'hero_cta', ['a', 'b']));
    expect(getPreviewMode()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AdaptiveDevtools — reflects registry changes without a re-mount', () => {
  it('drops a renamed id and shows the new one live (the Fast Refresh scenario)', () => {
    const unregister = registerComponent({ id: 'old_cta', variantIds: ['a', 'b'] });
    render(<AdaptiveDevtools />);
    openPanel();
    expect(screen.getByText(/old_cta/)).toBeTruthy();

    // Fast Refresh re-runs the registration effect: unregister the old id, register
    // the renamed one. The panel must update off the external-store subscription.
    act(() => {
      unregister();
      registerComponent({ id: 'new_cta', variantIds: ['a', 'b'] });
    });

    expect(screen.queryByText(/old_cta/)).toBeNull();
    expect(screen.getByText(/new_cta/)).toBeTruthy();
  });
});

describe('AdaptiveDevtools — slots write the slot-override channel', () => {
  it('an arms slot forces the arm into __sentient_slot_overrides (not the component channel) and notifies', () => {
    registerSlot({ id: 'services_order', arms: ['standard', 'services_first'] });
    render(<AdaptiveDevtools />);
    openPanel();
    const before = getOverridesVersion();

    fireEvent.click(screen.getByRole('button', { name: 'services_first' }));

    expect(w.__sentient_slot_overrides?.services_order).toBe('services_first');
    expect(w.__sentient_overrides?.services_order).toBeUndefined();
    expect(getPreviewMode()).toBe(true);
    expect(getOverridesVersion()).toBeGreaterThan(before);
    setPreviewMode(false);
  });

  it('a dims slot forces a token object into __sentient_slot_overrides', () => {
    registerSlot({ id: 'hero_style', dims: { tone: ['calm', 'urgent'] } });
    render(<AdaptiveDevtools />);
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'urgent' }));

    expect(w.__sentient_slot_overrides?.hero_style).toEqual({ tone: 'urgent' });
    expect(w.__sentient_overrides?.hero_style).toBeUndefined();
    expect(getPreviewMode()).toBe(true);
    setPreviewMode(false);
  });
});

describe('AdaptiveDevtools — SSR safety', () => {
  it('renders empty markup during a server render (no effects), so no window access and no hydration mismatch', () => {
    // renderToStaticMarkup never runs effects, so the client-mount gate keeps the
    // component null server-side. Without the gate it would render the launcher and
    // touch window during render — exactly what forces the dynamic({ssr:false}) wrapper.
    registerComponent({ id: 'hero_cta', variantIds: ['a', 'b'] });
    expect(renderToStaticMarkup(<AdaptiveDevtools />)).toBe('');
  });
});

describe('AdaptiveDevtools — keyed mode', () => {
  it('calls {apiBaseUrl}/explain with sections+components+slots and applies the full result', async () => {
    w.__sentient_devtools_config = { apiKey: 'pk_test', apiBaseUrl: 'https://api.example.com/v1', isLocal: false };
    registerComponent({ id: 'hero_cta', variantIds: ['a', 'b'] });
    registerSlot({ id: 'hero', dims: { tone: ['calm', 'urgent'] } });
    registerSections(['hero', 'pricing']);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        assignments: { hero_cta: 'b' },
        layoutOrder: ['pricing', 'hero'],
        slots: { hero: { tone: 'urgent' } },
        personaAttributes: { persona: 'buyer', confidence: 'high' },
      }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    render(<AdaptiveDevtools />);
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Buyer' }));

    await vi.waitFor(() => expect(getOverrides().hero_cta).toBe('b'));
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/explain');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.persona).toBe('buyer');
    expect(body.sections).toEqual([{ id: 'hero' }, { id: 'pricing' }]);
    expect(body.slots).toEqual([{ id: 'hero', dims: { tone: ['calm', 'urgent'] } }]);
    expect(w.__sentient_layout_override).toEqual(['pricing', 'hero']);
    expect(w.__sentient_slot_overrides?.hero).toEqual({ tone: 'urgent' });
    expect(document.documentElement.dataset.sentientPersona).toBe('buyer');
    expect(document.documentElement.dataset.sentientConfidence).toBe('high');
  });
});

describe('AdaptiveDevtools — layout reordering', () => {
  /** Drag `from` onto `to` using the same events the browser fires. */
  function drag(from: HTMLElement, to: HTMLElement): void {
    fireEvent.dragStart(from);
    fireEvent.dragOver(to);
    fireEvent.drop(to);
    fireEvent.dragEnd(from);
  }

  function rows(): HTMLElement[] {
    return screen.getAllByRole('listitem');
  }

  it('lists the declared sections in order', () => {
    registerSections(['hero', 'pricing', 'faq']);
    render(<AdaptiveDevtools />);
    openPanel();

    expect(rows().map((li) => li.textContent)).toEqual([
      '1⠿hero',
      '2⠿pricing',
      '3⠿faq',
    ]);
  });

  it('moves a block to an arbitrary position in one drop, not one step at a time', () => {
    registerSections(['hero', 'pricing', 'features', 'faq']);
    render(<AdaptiveDevtools />);
    openPanel();

    // Last to first — the move a neighbour swap would take three presses to do.
    drag(rows()[3]!, rows()[0]!);

    expect(w.__sentient_layout_override).toEqual(['faq', 'hero', 'pricing', 'features']);
    // An arrangement being tried must never train the optimizer.
    expect(getPreviewMode()).toBe(true);
    setPreviewMode(false);
  });

  it('notifies layout consumers so the page reorders without a reload', () => {
    registerSections(['hero', 'pricing']);
    render(<AdaptiveDevtools />);
    openPanel();
    const before = getOverridesVersion();

    drag(rows()[1]!, rows()[0]!);

    expect(getOverridesVersion()).toBeGreaterThan(before);
    setPreviewMode(false);
  });

  it('renders the previewed order, so a second drag builds on the first', () => {
    registerSections(['hero', 'pricing', 'faq']);
    render(<AdaptiveDevtools />);
    openPanel();

    drag(rows()[2]!, rows()[0]!); // faq, hero, pricing
    drag(rows()[2]!, rows()[0]!); // pricing, faq, hero

    expect(w.__sentient_layout_override).toEqual(['pricing', 'faq', 'hero']);
    setPreviewMode(false);
  });

  it('reset drops the override and leaves preview mode when nothing else is forced', () => {
    registerSections(['hero', 'pricing']);
    render(<AdaptiveDevtools />);
    openPanel();
    drag(rows()[1]!, rows()[0]!);

    fireEvent.click(screen.getByRole('button', { name: /reset section order/i }));

    expect(w.__sentient_layout_override).toBeUndefined();
    expect(getPreviewMode()).toBe(false);
    // Back to the registered order.
    expect(rows().map((li) => li.textContent)).toEqual(['1⠿hero', '2⠿pricing']);
  });

  it('keeps preview mode on while a variant is still forced', () => {
    registerSections(['hero', 'pricing']);
    registerComponent({ id: 'hero_cta', variantIds: ['a', 'b'], goal: 'signup' });
    render(<AdaptiveDevtools />);
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'b' }));
    drag(rows()[1]!, rows()[0]!);

    fireEvent.click(screen.getByRole('button', { name: /reset section order/i }));

    expect(w.__sentient_layout_override).toBeUndefined();
    expect(getPreviewMode()).toBe(true);
    setPreviewMode(false);
  });

  it('shows nothing to reorder when no sections are registered', () => {
    render(<AdaptiveDevtools />);
    openPanel();
    expect(screen.queryByRole('list', { name: /section order/i })).toBeNull();
    expect(screen.getByText(/no components, sections or slots/i)).toBeTruthy();
  });
});
