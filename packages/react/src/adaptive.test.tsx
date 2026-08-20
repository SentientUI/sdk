import { render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, useState, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { Adaptive } from './adaptive.js';
import { subscribeRegistry } from './devtools-registry.js';
import { init, attachMicroSignalDetectors } from '@sentientui/core';

vi.mock('@sentientui/core', () => ({
  init: vi.fn(),
  attachMicroSignalDetectors: vi.fn(() => () => undefined),
}));
vi.mock('@sentientui/core/engagement', () => ({ startEngagementCapture: vi.fn() }));
vi.mock('./segment.js', () => ({ detectSegment: () => 'desktop:direct' }));

const mockedInit = vi.mocked(init);
const mockedAttachMicroSignalDetectors = vi.mocked(attachMicroSignalDetectors);

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getAssignment: vi.fn().mockReturnValue({
      variantId: 'variant-a',
      assignedAt: Date.now(),
      segment: 'desktop:direct',
      confidence: 1,
    }),
    assign: vi.fn().mockResolvedValue({ variantId: 'variant-a', assignmentTtlMs: 0 }),
    destroy: vi.fn(),
    dispose: vi.fn(),
    track: vi.fn(),
    goal: vi.fn(),
    componentGoal: vi.fn(),
    identify: vi.fn(),
    getGraph: vi.fn().mockReturnValue({ pageNodes: [], capturedAt: 0 }),
    fetchWeights: vi.fn().mockResolvedValue([]),
    decide: vi.fn().mockResolvedValue(null),
    getSlotResult: vi.fn().mockReturnValue(null),
    getPersona: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return createElement(AdaptiveProvider, {
      enableGraph: false,
    apiKey: 'pk_test_key_1234',
    context: 'saas',
    consent: true,
    children,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IntersectionObserver', vi.fn(() => ({
    observe: vi.fn(),
    disconnect: vi.fn(),
    unobserve: vi.fn(),
  })));
});

describe('Adaptive â€” rendering', () => {
  it('renders the assigned variant', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { findByText } = render(
      createElement(Adaptive, {
        id: 'hero',
        variants: { 'variant-a': createElement('span', null, 'Hello A'), 'variant-b': createElement('span', null, 'Hello B') },
        goal: 'click',
      }),
      { wrapper },
    );

    expect(await findByText('Hello A')).toBeTruthy();
  });

  it('re-renders dynamic content inside a variant when a parent value changes', async () => {
    // Regression: the memo comparator once compared only variant KEYS, so the
    // assigned variant's content froze at its first value even as props changed
    // (the assignment/variantId is stable). It must compare variant nodes too.
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    function Parent() {
      const [price, setPrice] = useState(10);
      return createElement(
        'div',
        null,
        createElement('button', { onClick: () => setPrice((p) => p + 5) }, 'bump'),
        createElement(Adaptive, {
          id: 'hero',
          variants: { 'variant-a': createElement('span', null, `Price: ${price}`) },
          goal: 'click',
        }),
      );
    }

    const { findByText, getByText } = render(createElement(Parent), { wrapper });
    expect(await findByText('Price: 10')).toBeTruthy();
    fireEvent.click(getByText('bump'));
    expect(await findByText('Price: 15')).toBeTruthy();
  });

  it('renders first variant during SSR when consent is false (seo fallback)', () => {
    function noConsentWrapper({ children }: { children: ReactNode }) {
      return createElement(AdaptiveProvider, {
      enableGraph: false,
        apiKey: 'pk_test',
        context: 'saas',
            consent: false,
        children,
      });
    }

    const { container } = render(
      createElement(Adaptive, {
        id: 'hero',
        variants: {
          'variant-a': createElement('span', null, 'Hello A'),
          'variant-b': createElement('span', null, 'Hello B'),
        },
        goal: 'click',
      }),
      { wrapper: noConsentWrapper },
    );

    expect(container.textContent).toBe('Hello A');
    expect(container.querySelector('[data-sentient-variant="variant-a"]')).toBeTruthy();
  });

  it('renders nothing when clientOnly=true before mount (SSR simulation)', () => {
    // With consent=false the client is null, so clientOnly should render null.
    function noConsentWrapper({ children }: { children: ReactNode }) {
      return createElement(AdaptiveProvider, {
      enableGraph: false,
        apiKey: 'pk_test',
        context: 'saas',
            consent: false,
        children,
      });
    }

    const { container } = render(
      createElement(Adaptive, {
        id: 'hero',
        variants: { 'variant-a': createElement('span', null, 'Hello A') },
        goal: 'click',
        clientOnly: true,
      }),
      { wrapper: noConsentWrapper },
    );

    expect(container.querySelector('[data-sentient-id]')).toBeNull();
  });
});

describe('Adaptive â€” variant_assigned tracking', () => {
  it('calls client.track with variant_assigned once on mount', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { findByTestId } = render(
      createElement(Adaptive, {
        id: 'hero',
        variants: { 'variant-a': createElement('div', { 'data-testid': 'va' }, 'A') },
        goal: 'click',
      }),
      { wrapper },
    );

    await findByTestId('va');

    const assignedCalls = client.track.mock.calls.filter(
      ([e]) => e.eventType === 'variant_assigned',
    );
    expect(assignedCalls).toHaveLength(1);
    expect(assignedCalls[0][0]).toMatchObject({
      componentId: 'hero',
      variantId: 'variant-a',
      eventType: 'variant_assigned',
    });
    expect(typeof assignedCalls[0][0].payload).toBe('object');
    expect(assignedCalls[0][0].payload).toEqual({});
  });

  it('fires variant_assigned even when the assigned variant renders empty DOM', async () => {
    // Regression: exposure used to be gated on the container having non-empty
    // innerHTML (to capture previewHtml). A variant that legitimately renders
    // nothing therefore never emitted variant_assigned, so the optimizer never
    // learned from it. Exposure must not depend on rendered content.
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    render(
      createElement(Adaptive, {
        id: 'hero-empty',
        variants: { 'variant-a': null },
        goal: 'click',
      }),
      { wrapper },
    );

    await waitFor(() =>
      expect(
        client.track.mock.calls.filter(([e]) => e.eventType === 'variant_assigned'),
      ).toHaveLength(1),
    );
    const assignedCalls = client.track.mock.calls.filter(
      ([e]) => e.eventType === 'variant_assigned',
    );
    expect(assignedCalls[0][0]).toMatchObject({
      componentId: 'hero-empty',
      variantId: 'variant-a',
      eventType: 'variant_assigned',
    });
    expect(assignedCalls[0][0].payload).toEqual({});
  });

  it('does not fire a phantom baseline exposure on the CSR path before assign resolves (#1)', async () => {
    // No SSR preload + empty cache: the served variant resolves in two steps
    // (interim baseline variantIds[0] â†’ bandit choice). Only the settled
    // bandit variant may emit variant_assigned â€” the interim baseline must not,
    // or that arm accrues an impression that can never convert.
    const client = makeClient({
      getAssignment: vi.fn().mockReturnValue(null),
      assign: vi.fn().mockResolvedValue({ variantId: 'variant-b', assignmentTtlMs: 0 }),
    });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { findByTestId } = render(
      createElement(Adaptive, {
        id: 'hero-csr',
        variants: {
          'variant-a': createElement('div', { 'data-testid': 'va' }, 'A'),
          'variant-b': createElement('div', { 'data-testid': 'vb' }, 'B'),
        },
        goal: 'click',
      }),
      { wrapper },
    );

    // The bandit serves variant-b (variantIds[0] = variant-a is only interim).
    await findByTestId('vb');

    await waitFor(() => {
      const assignedCalls = client.track.mock.calls.filter(
        ([e]) => e.eventType === 'variant_assigned',
      );
      expect(assignedCalls).toHaveLength(1);
      expect(assignedCalls[0][0]).toMatchObject({ componentId: 'hero-csr', variantId: 'variant-b' });
    });

    // The interim baseline variant-a must NOT have accrued an exposure.
    const baselineExposures = client.track.mock.calls.filter(
      ([e]) => e.eventType === 'variant_assigned' && e.variantId === 'variant-a',
    );
    expect(baselineExposures).toHaveLength(0);
  });

  it('does not fire variant_assigned a second time on re-render', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { rerender, findByTestId } = render(
      createElement(Adaptive, {
        id: 'hero',
        variants: { 'variant-a': createElement('div', { 'data-testid': 'va' }, 'A') },
        goal: 'click',
      }),
      { wrapper },
    );

    await findByTestId('va');
    rerender(
      createElement(Adaptive, {
        id: 'hero',
        variants: { 'variant-a': createElement('div', { 'data-testid': 'va' }, 'A') },
        goal: 'click',
      }),
    );

    expect(
      client.track.mock.calls.filter(([e]) => e.eventType === 'variant_assigned'),
    ).toHaveLength(1);
  });
});

describe('Adaptive â€” form_submit goal', () => {
  it('fires goal_achieved when a form inside the variant is submitted', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { findByRole } = render(
      createElement(Adaptive, {
        id: 'signup',
        variants: {
          'variant-a': createElement('form', null,
            createElement('input', { type: 'text' }),
            createElement('button', { type: 'submit' }, 'Submit'),
          ),
        },
        goal: { type: 'form_submit' },
      }),
      { wrapper },
    );

    const btn = await findByRole('button', { name: 'Submit' });
    fireEvent.submit(btn.closest('form')!);

    const goalCalls = client.track.mock.calls.filter(([e]) => e.eventType === 'goal_achieved');
    expect(goalCalls).toHaveLength(1);
    expect(goalCalls[0][0]).toMatchObject({
      componentId: 'signup',
      variantId: 'variant-a',
      eventType: 'goal_achieved',
      payload: { reward: 1.0 },
    });
  });

  it('fires form_submit goal only once even if the form is submitted multiple times', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { findByRole } = render(
      createElement(Adaptive, {
        id: 'signup',
        variants: {
          'variant-a': createElement('form', null,
            createElement('button', { type: 'submit' }, 'Submit'),
          ),
        },
        goal: { type: 'form_submit' },
      }),
      { wrapper },
    );

    const btn = await findByRole('button', { name: 'Submit' });
    const form = btn.closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(
      client.track.mock.calls.filter(([e]) => e.eventType === 'goal_achieved'),
    ).toHaveLength(1);
  });
});

describe('Adaptive â€” agentData prop', () => {
  it('passes agentData to client.assign as third argument', async () => {
    // Disable cache so assign() is actually called
    const client = makeClient({
      getAssignment: vi.fn().mockReturnValue(null),
      assign: vi.fn().mockResolvedValue({ variantId: 'variant-a', assignmentTtlMs: 0 }),
    });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { findByTestId } = render(
      createElement(Adaptive, {
        id: 'hero-agent',
        variants: { 'variant-a': createElement('div', { 'data-testid': 'va' }, 'A') },
        goal: 'click',
        agentData: { headline: 'Ship faster', cta: 'Try free' },
      }),
      { wrapper },
    );

    await findByTestId('va');

    expect(client.assign).toHaveBeenCalledWith(
      'hero-agent',
      expect.any(Array),
      { headline: 'Ship faster', cta: 'Try free' },
      undefined,
    );
  });

  it('calls assign with undefined agentData when prop is omitted', async () => {
    const client = makeClient({
      getAssignment: vi.fn().mockReturnValue(null),
      assign: vi.fn().mockResolvedValue({ variantId: 'variant-a', assignmentTtlMs: 0 }),
    });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { findByTestId } = render(
      createElement(Adaptive, {
        id: 'hero-no-agent',
        variants: { 'variant-a': createElement('div', { 'data-testid': 'vb' }, 'B') },
        goal: 'click',
      }),
      { wrapper },
    );

    await findByTestId('vb');

    expect(client.assign).toHaveBeenCalledWith(
      'hero-no-agent',
      expect.any(Array),
      undefined,
      undefined,
    );
  });
});

describe('Adaptive â€” click goal', () => {
  it('fires goal_achieved with reward=1 when a button inside the variant is clicked', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { findByRole } = render(
      createElement(Adaptive, {
        id: 'cta',
        variants: {
          'variant-a': createElement('button', null, 'Buy now'),
        },
        goal: 'click',
      }),
      { wrapper },
    );

    const btn = await findByRole('button', { name: 'Buy now' });
    fireEvent.click(btn);

    const goalCalls = client.track.mock.calls.filter(([e]) => e.eventType === 'goal_achieved');
    expect(goalCalls).toHaveLength(1);
    expect(goalCalls[0][0]).toMatchObject({
      componentId: 'cta',
      variantId: 'variant-a',
      eventType: 'goal_achieved',
      payload: { reward: 1.0 },
    });
  });

  it('fires goal_achieved only once even if clicked multiple times', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { findByRole } = render(
      createElement(Adaptive, {
        id: 'cta',
        variants: { 'variant-a': createElement('button', null, 'Click') },
        goal: 'click',
      }),
      { wrapper },
    );

    const btn = await findByRole('button', { name: 'Click' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(
      client.track.mock.calls.filter(([e]) => e.eventType === 'goal_achieved'),
    ).toHaveLength(1);
  });
});

describe('Adaptive â€” weighted_composite goal', () => {
  it('fires goal_achieved with step weight when a step fires, not waiting for other steps', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { findByRole } = render(
      createElement(Adaptive, {
        id: 'checkout',
        variants: {
          'variant-a': createElement('div', null,
            createElement('button', null, 'CTA'),
          ),
        },
        goal: {
          type: 'weighted_composite',
          steps: [
            { goal: { type: 'click' }, name: 'clicked_cta', weight: 0.4 },
            { goal: { type: 'form_submit' }, name: 'signed_up', weight: 1.0 },
          ],
        },
      }),
      { wrapper },
    );

    const btn = await findByRole('button', { name: 'CTA' });
    fireEvent.click(btn);

    // Step 0 fires immediately with its weight
    const goalCalls = client.track.mock.calls.filter(([e]) => e.eventType === 'goal_achieved');
    expect(goalCalls).toHaveLength(1);
    expect(goalCalls[0][0]).toMatchObject({
      componentId: 'checkout',
      eventType: 'goal_achieved',
      goalType: 'clicked_cta',
      payload: { reward: 0.4 },
    });

    // client.goal() called with weight and stepIndex (options form)
    expect(client.goal).toHaveBeenCalledWith('clicked_cta', { metadata: {}, weight: 0.4, stepIndex: 0 });

    // form_submit step has not fired
    expect(client.track.mock.calls.filter(([e]) => e.goalType === 'signed_up')).toHaveLength(0);
  });

  it('fires each step at most once per mount', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { findByRole } = render(
      createElement(Adaptive, {
        id: 'once-test',
        variants: {
          'variant-a': createElement('div', null, createElement('button', null, 'Go')),
        },
        goal: {
          type: 'weighted_composite',
          steps: [{ goal: { type: 'click' }, name: 'clicked', weight: 0.5 }],
        },
      }),
      { wrapper },
    );

    const btn = await findByRole('button', { name: 'Go' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(
      client.track.mock.calls.filter(([e]) => e.goalType === 'clicked'),
    ).toHaveLength(1);
  });

  it('steps fire independently â€” later step fires without earlier step', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { container, findByText } = render(
      createElement(Adaptive, {
        id: 'indep-test',
        variants: {
          'variant-a': createElement('div', null,
            createElement('span', null, 'content'),
            createElement('form', null, createElement('button', { type: 'submit' }, 'Submit')),
          ),
        },
        goal: {
          type: 'weighted_composite',
          steps: [
            { goal: { type: 'click' }, name: 'clicked_cta', weight: 0.3 },
            { goal: { type: 'form_submit' }, name: 'submitted', weight: 1.0 },
          ],
        },
      }),
      { wrapper },
    );

    await findByText('content');

    // Fire form_submit without clicking first
    const form = container.querySelector('form')!;
    fireEvent.submit(form);

    const submittedCalls = client.track.mock.calls.filter(([e]) => e.goalType === 'submitted');
    expect(submittedCalls).toHaveLength(1);
    expect(submittedCalls[0][0].payload).toEqual({ reward: 1.0 });
  });
});

describe('Adaptive â€” findClickable invalid selector', () => {
  it('treats an invalid CSS selector as no-match (no throw, goal does not fire)', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { findByRole } = render(
      createElement(Adaptive, {
        id: 'bad-selector',
        variants: { 'variant-a': createElement('button', null, 'Buy now') },
        // Malformed selector â€” Element.matches() throws SyntaxError, which is caught.
        goal: { type: 'click', selector: ':::not-a-selector(' },
      }),
      { wrapper },
    );

    const btn = await findByRole('button', { name: 'Buy now' });
    // Must not throw despite the invalid selector inside the click handler.
    expect(() => fireEvent.click(btn)).not.toThrow();

    // No match -> goal_achieved never fires.
    expect(
      client.track.mock.calls.filter(([e]) => e.eventType === 'goal_achieved'),
    ).toHaveLength(0);
  });

  it('fires the goal when a valid selector matches the clicked element', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { findByRole } = render(
      createElement(Adaptive, {
        id: 'good-selector',
        variants: { 'variant-a': createElement('button', { className: 'cta' }, 'Buy now') },
        goal: { type: 'click', selector: '.cta' },
      }),
      { wrapper },
    );

    const btn = await findByRole('button', { name: 'Buy now' });
    fireEvent.click(btn);

    expect(
      client.track.mock.calls.filter(([e]) => e.eventType === 'goal_achieved'),
    ).toHaveLength(1);
  });
});

describe('Adaptive â€” clientOnly render branches', () => {
  it('renders the variant once mounted with a live client (clientOnly=true)', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    const { findByTestId, container } = render(
      createElement(Adaptive, {
        id: 'client-only-live',
        variants: { 'variant-a': createElement('div', { 'data-testid': 'va' }, 'Hello A') },
        goal: 'click',
        clientOnly: true,
      }),
      { wrapper },
    );

    // After mount + client present, the null branch is no longer taken.
    await findByTestId('va');
    expect(container.querySelector('[data-sentient-id="client-only-live"]')).toBeTruthy();
  });
});

describe('Adaptive â€” dev override suppresses tracking', () => {
  it('records nothing while a variant is forced (no exposure, no goal, no micro-signals)', async () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);
    // The README promise is "force a variant without touching the bandit â€”
    // no events recorded, weights unchanged". A human dev browsing with an
    // override otherwise trains the forced variant with reward-1.0 goals.
    window.__sentient_overrides = { 'cta-forced': 'variant-b' };

    try {
      const { findByRole } = render(
        createElement(Adaptive, {
          id: 'cta-forced',
          variants: {
            'variant-a': createElement('button', null, 'A'),
            'variant-b': createElement('button', null, 'B'),
          },
          goal: 'click',
        }),
        { wrapper },
      );

      const btn = await findByRole('button', { name: 'B' });
      fireEvent.click(btn);

      expect(client.track).not.toHaveBeenCalled();
      expect(client.goal).not.toHaveBeenCalled();
      expect(client.assign).not.toHaveBeenCalled();
      expect(mockedAttachMicroSignalDetectors).not.toHaveBeenCalled();
    } finally {
      delete window.__sentient_overrides;
    }
  });
});

describe('Adaptive â€” variantIds memoization (#2)', () => {
  it('does not re-register the component on an unrelated re-render with an inline variants literal', async () => {
    // Regression: keying the variantIds memo on `props.variants` (a fresh object
    // for an inline `variants={{...}}` literal) churned a new array every commit,
    // re-running the register effect and unregistering+re-registering the
    // component on each render. Freezing on the key SET keeps registration stable.
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    function Parent() {
      const [n, setN] = useState(0);
      return createElement(
        'div',
        null,
        createElement('button', { onClick: () => setN((x) => x + 1) }, 'rerender'),
        createElement('span', null, `n:${n}`),
        // Inline literal â€” a brand-new object identity on every Parent render.
        createElement(Adaptive, {
          id: 'reg-hero',
          variants: { 'variant-a': createElement('span', null, 'A') },
          goal: 'click',
        }),
      );
    }

    const { getByText, findByText } = render(createElement(Parent), { wrapper });
    await findByText('A'); // mount (and initial registration) done

    let mutations = 0;
    const unsub = subscribeRegistry(() => {
      mutations += 1;
    });
    fireEvent.click(getByText('rerender'));
    await findByText('n:1');
    fireEvent.click(getByText('rerender'));
    await findByText('n:2');
    unsub();

    // With the bug each re-render unregisters+re-registers (2 registry mutations
    // per commit). Stable variantIds => zero registry churn after mount.
    expect(mutations).toBe(0);
  });
});

describe('Adaptive â€” micro-signals gated on settled (#3)', () => {
  it('attaches no micro-signal detectors (no micro_signal / goal) before the assignment settles', async () => {
    // On the CSR path the served variant resolves in two steps: interim baseline
    // (variantIds[0]) â†’ bandit choice. A rage-click / tab-loss during that window
    // used to record a micro_signal and fire a mapped named goal attributed to
    // the interim baseline. The effect must wait for `settled` like the exposure.
    let resolveAssign!: (r: unknown) => void;
    const client = makeClient({
      getAssignment: vi.fn().mockReturnValue(null),
      assign: vi.fn().mockReturnValue(
        new Promise((res) => {
          resolveAssign = res;
        }),
      ),
    });
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    let emit: ((signalType: string) => void) | undefined;
    mockedAttachMicroSignalDetectors.mockImplementation((emitter) => {
      emit = emitter as (signalType: string) => void;
      return () => undefined;
    });

    const { findByTestId } = render(
      createElement(Adaptive, {
        id: 'hero-presettle',
        variants: {
          'variant-a': createElement('div', { 'data-testid': 'va' }, 'A'),
          'variant-b': createElement('div', { 'data-testid': 'vb' }, 'B'),
        },
        goal: 'click',
        microSignalGoals: { rage_click: 'confused_by_hero' },
      }),
      { wrapper },
    );

    // Interim baseline (variant-a) is on screen but assign() has not resolved.
    await findByTestId('va');
    expect(mockedAttachMicroSignalDetectors).not.toHaveBeenCalled();

    // Settle on the bandit's real choice.
    resolveAssign({ variantId: 'variant-b', assignmentTtlMs: 0 });
    await findByTestId('vb');
    await waitFor(() => expect(mockedAttachMicroSignalDetectors).toHaveBeenCalled());

    // Now a micro-signal records against the settled arm only.
    emit!('rage_click');
    expect(client.goal).toHaveBeenCalledWith(
      'confused_by_hero',
      expect.objectContaining({
        metadata: expect.objectContaining({ signalType: 'rage_click' }),
        weight: 1.0,
        stepIndex: 0,
      }),
    );
    const microEvents = client.track.mock.calls.filter(([e]) => e.eventType === 'micro_signal');
    expect(microEvents).toHaveLength(1);
    expect(microEvents[0][0]).toMatchObject({ componentId: 'hero-presettle', variantId: 'variant-b' });
  });
});

describe('Adaptive â€” microSignalGoals', () => {
  it('calls client.goal when a mapped micro-signal fires', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as ReturnType<typeof init>);

    let emit: ((signalType: string) => void) | undefined;
    mockedAttachMicroSignalDetectors.mockImplementation((emitter) => {
      emit = emitter as (signalType: string) => void;
      return () => undefined;
    });

    render(
      createElement(Adaptive, {
        id: 'hero',
        variants: { 'variant-a': createElement('div', null, 'A') },
        goal: 'click',
        microSignalGoals: { rage_click: 'confused_by_hero' },
      }),
      { wrapper },
    );

    expect(mockedAttachMicroSignalDetectors).toHaveBeenCalled();
    emit!('rage_click');

    expect(client.goal).toHaveBeenCalledWith(
      'confused_by_hero',
      expect.objectContaining({
        metadata: expect.objectContaining({ signalType: 'rage_click' }),
        weight: 1.0,
        stepIndex: 0,
      }),
    );
  });
});
