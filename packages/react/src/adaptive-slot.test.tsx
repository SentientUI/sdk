import { render, fireEvent } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { createElement, type ReactNode } from 'react';
import { applyScenario, resetScenario } from './testing/scenario.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { AdaptiveSlot } from './adaptive-slot.js';
import { init } from '@sentientui/core';

vi.mock('@sentientui/core', () => ({
  init: vi.fn(),
  detectDeviceClass: () => 'desktop',
  detectTrafficSource: () => 'direct',
  armOfResult: (r: string | Record<string, string>) =>
    typeof r === 'string'
      ? r
      : Object.keys(r).sort().map((k) => `${k}=${r[k]}`).join('|'),
  containsFormBlock: function containsFormBlock(node: unknown): boolean {
    if (node == null || typeof node !== 'object' || Array.isArray(node)) return false;
    const n = node as { type?: unknown; children?: unknown[] };
    if (n.type === 'form') return true;
    return Array.isArray(n.children) ? n.children.some(containsFormBlock) : false;
  },
}));
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn() }));

const mockedInit = vi.mocked(init);

const BLOCK_TREE = {
  type: 'stack',
  direction: 'column',
  children: [{ type: 'heading', value: 'Compare us in 5 min', level: 2 }],
};
const FORM_TREE = {
  type: 'stack',
  direction: 'column',
  children: [
    { type: 'heading', value: 'Get the benchmark', level: 2 },
    {
      type: 'form',
      submitGoal: 'lead_capture',
      submitLabel: 'Send',
      fields: [{ kind: 'input', name: 'work_email', label: 'Work email', inputType: 'email' }],
    },
  ],
};

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getAssignment: vi.fn().mockReturnValue(null),
    assign: vi.fn().mockResolvedValue(null),
    decide: vi.fn().mockResolvedValue(null),
    getSlotResult: vi.fn().mockReturnValue(null),
    getSlotConfig: vi.fn().mockReturnValue(null),
    getSitePalette: vi.fn().mockReturnValue(null),
    reportSlots: vi.fn(),
    getPersona: vi.fn().mockReturnValue(null),
    destroy: vi.fn(),
    dispose: vi.fn(),
    track: vi.fn(),
    goal: vi.fn(),
    componentGoal: vi.fn(),
    identify: vi.fn(),
    getGraph: vi.fn().mockReturnValue({ pageNodes: [], capturedAt: 0 }),
    fetchWeights: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function wrapperWith(props: Record<string, unknown> = {}) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(AdaptiveProvider, {
      enableGraph: false,
      apiKey: 'pk_test',
      context: 'saas',
      consent: true,
      ...props,
      children,
    } as never);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedInit.mockReturnValue(makeClient() as never);
});

afterEach(() => {
  resetScenario();
});

describe('AdaptiveSlot rendering', () => {
  it('renders children inside the slot container when no config exists', () => {
    const Wrapper = wrapperWith();
    const { container } = render(
      <Wrapper>
        <AdaptiveSlot id="hero">
          <button>Start free</button>
        </AdaptiveSlot>
      </Wrapper>,
    );
    const slot = container.querySelector('[data-sentient-slot="hero"]')!;
    expect(slot).not.toBeNull();
    expect(slot.querySelector('button')!.textContent).toBe('Start free');
  });

  it('renders served content string instead of children', () => {
    const Wrapper = wrapperWith({
      initialSlotConfig: { hero: { kind: 'arms', content: 'Generated headline' } },
      initialSlots: { hero: 'researcher_v1' },
    });
    const { container } = render(
      <Wrapper>
        <AdaptiveSlot id="hero">
          <button>Start free</button>
        </AdaptiveSlot>
      </Wrapper>,
    );
    const slot = container.querySelector('[data-sentient-slot="hero"]')!;
    expect(slot.textContent).toBe('Generated headline');
    expect(slot.querySelector('button')).toBeNull();
    expect(slot.getAttribute('data-sentient-arm')).toBe('researcher_v1');
  });

  it('renders the served arm’s block tree; baseline arm (no tree) renders children', () => {
    const cfg = { kind: 'arms' as const, blocks: { researcher_v1: BLOCK_TREE } };
    const served = wrapperWith({ initialSlotConfig: { hero: cfg }, initialSlots: { hero: 'researcher_v1' } });
    const { container } = render(
      createElement(served, null, <AdaptiveSlot id="hero"><button>Start free</button></AdaptiveSlot>),
    );
    expect(container.querySelector('h2')!.textContent).toBe('Compare us in 5 min');
    expect(container.querySelector('button')).toBeNull();

    const baseline = wrapperWith({ initialSlotConfig: { hero: cfg }, initialSlots: { hero: 'baseline' } });
    const { container: c2 } = render(
      createElement(baseline, null, <AdaptiveSlot id="hero"><button>Start free</button></AdaptiveSlot>),
    );
    expect(c2.querySelector('h2')).toBeNull();
    expect(c2.querySelector('button')!.textContent).toBe('Start free');
  });

  it('refuses a form tree whole without onFormSubmit (children render, one dev warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const Wrapper = wrapperWith({
      initialSlotConfig: { hero: { kind: 'arms', blocks: { researcher_v1: FORM_TREE } } },
      initialSlots: { hero: 'researcher_v1' },
    });
    const { container, rerender } = render(
      createElement(Wrapper, null, <AdaptiveSlot id="hero"><button>Start free</button></AdaptiveSlot>),
    );
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('h2')).toBeNull(); // whole tree refused, not just the form node
    expect(container.querySelector('button')!.textContent).toBe('Start free');
    rerender(createElement(Wrapper, null, <AdaptiveSlot id="hero"><button>Start free</button></AdaptiveSlot>));
    const formWarns = warn.mock.calls.filter((c) => String(c[0]).includes('form'));
    expect(formWarns.length).toBe(1);
    warn.mockRestore();
  });

  it('renders the form with onFormSubmit; submit fires slot-shaped goals and never leaks values', () => {
    const onFormSubmit = vi.fn();
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith({
      initialSlotConfig: { hero: { kind: 'arms', blocks: { researcher_v1: FORM_TREE } } },
      initialSlots: { hero: 'researcher_v1' },
    });
    const { container, getByLabelText, rerender } = render(
      createElement(Wrapper, null, (
        <AdaptiveSlot id="hero" onFormSubmit={onFormSubmit}>
          <button>Start free</button>
        </AdaptiveSlot>
      )),
    );
    rerender(
      createElement(Wrapper, null, (
        <AdaptiveSlot id="hero" onFormSubmit={onFormSubmit}>
          <button>Start free</button>
        </AdaptiveSlot>
      )),
    );

    fireEvent.change(getByLabelText('Work email'), { target: { value: 'a@b.co' } });
    fireEvent.submit(container.querySelector('form')!);

    expect(onFormSubmit).toHaveBeenCalledWith({ work_email: 'a@b.co' });
    expect(client.componentGoal).toHaveBeenCalledWith('hero', 'lead_capture');
    expect(client.goal).toHaveBeenCalledWith('lead_capture', {
      metadata: { componentId: 'hero', arm: 'researcher_v1' },
      weight: 1.0,
      stepIndex: 0,
    });
    // Privacy line: no tracked payload may carry a field value.
    const allTracked = [...client.track.mock.calls, ...client.goal.mock.calls, ...client.componentGoal.mock.calls];
    expect(JSON.stringify(allTracked)).not.toContain('a@b.co');
  });

  it('applyScenario({ slotConfig, slots }) forces a deterministic render', () => {
    applyScenario({
      slotConfig: { hero: { kind: 'arms', blocks: { forced: BLOCK_TREE } } },
      slots: { hero: 'forced' },
    });
    const Wrapper = wrapperWith();
    const { container } = render(
      createElement(Wrapper, null, <AdaptiveSlot id="hero"><button>Start free</button></AdaptiveSlot>),
    );
    expect(container.querySelector('h2')!.textContent).toBe('Compare us in 5 min');
  });

  it('SSR renders the arm’s blocks and the client first render agrees', () => {
    const props = {
      initialSlotConfig: { hero: { kind: 'arms' as const, blocks: { researcher_v1: BLOCK_TREE } } },
      initialSlots: { hero: 'researcher_v1' },
    };
    const Wrapper = wrapperWith(props);
    const slotEl = <AdaptiveSlot id="hero"><button>Start free</button></AdaptiveSlot>;
    const ssrHtml = renderToString(createElement(Wrapper, null, slotEl));
    expect(ssrHtml).toContain('Compare us in 5 min');
    expect(ssrHtml).not.toContain('Start free');

    const { container } = render(createElement(Wrapper, null, slotEl));
    expect(container.querySelector('h2')!.textContent).toBe('Compare us in 5 min');
  });

  it('records one exposure per served arm and none for overrides or unserved slots', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith({
      initialSlotConfig: { hero: { kind: 'arms', content: 'Generated headline' } },
      initialSlots: { hero: 'researcher_v1' },
    });
    const el = <AdaptiveSlot id="hero"><button>b</button></AdaptiveSlot>;
    const { rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el));
    const exposures = client.track.mock.calls.filter((c) => (c[0] as { eventType?: string })?.eventType === 'variant_assigned');
    expect(exposures.length).toBe(1);

    client.track.mockClear();
    applyScenario({ slotConfig: { forced_slot: { kind: 'arms', content: 'x' } }, slots: { forced_slot: 'f1' } });
    const W2 = wrapperWith();
    render(createElement(W2, null, <AdaptiveSlot id="forced_slot">base</AdaptiveSlot>));
    const overrideExposures = client.track.mock.calls.filter((c) => (c[0] as { eventType?: string })?.eventType === 'variant_assigned');
    expect(overrideExposures.length).toBe(0);
  });
});
