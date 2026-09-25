import { render, fireEvent } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { createElement, type ReactNode } from 'react';
import { applyScenario, resetScenario } from './testing/scenario.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveProvider } from './provider.js';
import { AdaptiveSlot } from './adaptive-slot.js';
import { init } from '@sentientui/core';

vi.mock('@sentientui/core', () => ({
  // AdaptiveSlot imports `reveal` from core. These mocks are deliberately
  // minimal — they exist so the suite never loads real core — so every core
  // import the rendered tree makes has to be listed here.
  reveal: vi.fn(),
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
    flush: vi.fn(), dispose: vi.fn(),
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

  // This test used to assert the bug: the served copy replaced the whole
  // <button> with a bare string, so a generated version of a styled CTA
  // rendered as unstyled text (Bodyshop, 2026-09-23).
  it('puts served content inside the developer’s element, keeping its markup and classes', () => {
    const Wrapper = wrapperWith({
      initialSlotConfig: { hero: { kind: 'arms', content: 'Generated headline' } },
      initialSlots: { hero: 'evaluator_v1' },
    });
    const { container } = render(
      <Wrapper>
        <AdaptiveSlot id="hero">
          <button className="btn btn-primary">
            <svg data-icon="arrow" />
            Start free
          </button>
        </AdaptiveSlot>
      </Wrapper>,
    );
    const slot = container.querySelector('[data-sentient-slot="hero"]')!;
    const button = slot.querySelector('button')!;
    expect(button).not.toBeNull();
    expect(button.className).toBe('btn btn-primary');
    expect(button.querySelector('svg[data-icon="arrow"]')).not.toBeNull();
    expect(button.textContent).toBe('Generated headline');
    expect(slot.getAttribute('data-sentient-arm')).toBe('evaluator_v1');
  });

  it('reaches text passed as children of a custom component', () => {
    function Cta({ children }: { children: ReactNode }) {
      return <a className="cta" href="/book">{children}</a>;
    }
    const Wrapper = wrapperWith({
      initialSlotConfig: { hero: { kind: 'arms', content: 'Book your MOT' } },
      initialSlots: { hero: 'evaluator_v1' },
    });
    const { container } = render(
      <Wrapper>
        <AdaptiveSlot id="hero"><Cta>Book now</Cta></AdaptiveSlot>
      </Wrapper>,
    );
    const a = container.querySelector('a.cta')!;
    expect(a.textContent).toBe('Book your MOT');
    expect(a.getAttribute('href')).toBe('/book');
  });

  // Bodyshop 2026-09-23: two <a> buttons under one flex <div>. Keeping the
  // root and flattening its inside still rendered a sentence where the buttons
  // were. A single string has nowhere structural to go in a multi-text region,
  // so the original renders and no exposure is recorded.
  it('refuses a content arm on a multi-text region: children render, no exposure', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith({
      initialSlotConfig: { cta: { kind: 'arms', content: 'Get in touch Send photos over WhatsApp' } },
      initialSlots: { cta: 'unknown_v1' },
    });
    const { container } = render(
      createElement(
        Wrapper,
        null,
        <AdaptiveSlot id="cta">
          <div className="flex gap-4">
            <a className="btn-primary" href="/contact">Get in touch</a>
            <a className="btn-outline" href="https://api.whatsapp.com/send">WhatsApp photos</a>
          </div>
        </AdaptiveSlot>,
      ),
    );
    expect(container.querySelector('a.btn-primary')!.textContent).toBe('Get in touch');
    expect(container.querySelector('a.btn-outline')!.textContent).toBe('WhatsApp photos');
    const exposures = client.track.mock.calls.filter((c) => (c[0] as { eventType?: string })?.eventType === 'variant_assigned');
    expect(exposures.length).toBe(0);
  });

  it('renders children and records no exposure when the text is unreachable (label prop)', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    function Cta({ label }: { label: string }) {
      return <button className="cta">{label}</button>;
    }
    const Wrapper = wrapperWith({
      initialSlotConfig: { hero: { kind: 'arms', content: 'Generated' } },
      initialSlots: { hero: 'evaluator_v1' },
    });
    const { container } = render(
      createElement(Wrapper, null, <AdaptiveSlot id="hero"><Cta label="Book now" /></AdaptiveSlot>),
    );
    expect(container.querySelector('button.cta')!.textContent).toBe('Book now');
    const exposures = client.track.mock.calls.filter((c) => (c[0] as { eventType?: string })?.eventType === 'variant_assigned');
    expect(exposures.length).toBe(0);
  });

  it('renders the served arm’s block tree; baseline arm (no tree) renders children', () => {
    const cfg = { kind: 'arms' as const, blocks: { evaluator_v1: BLOCK_TREE } };
    const served = wrapperWith({ initialSlotConfig: { hero: cfg }, initialSlots: { hero: 'evaluator_v1' } });
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
      initialSlotConfig: { hero: { kind: 'arms', blocks: { evaluator_v1: FORM_TREE } } },
      initialSlots: { hero: 'evaluator_v1' },
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
      initialSlotConfig: { hero: { kind: 'arms', blocks: { evaluator_v1: FORM_TREE } } },
      initialSlots: { hero: 'evaluator_v1' },
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
      metadata: { componentId: 'hero', arm: 'evaluator_v1' },
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
      initialSlotConfig: { hero: { kind: 'arms' as const, blocks: { evaluator_v1: BLOCK_TREE } } },
      initialSlots: { hero: 'evaluator_v1' },
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
      initialSlots: { hero: 'evaluator_v1' },
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

  it('records exactly one exposure for a healthy block-tree arm', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith({
      initialSlotConfig: { hero: { kind: 'arms', blocks: { evaluator_v1: BLOCK_TREE } } },
      initialSlots: { hero: 'evaluator_v1' },
    });
    const el = <AdaptiveSlot id="hero"><button>b</button></AdaptiveSlot>;
    const { container, rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el));
    expect(container.querySelector('h2')).not.toBeNull(); // the arm actually rendered
    const exposures = client.track.mock.calls.filter((c) => (c[0] as { eventType?: string })?.eventType === 'variant_assigned');
    expect(exposures.length).toBe(1);
  });

  it('suppresses the exposure when the form gate blocks the served arm', () => {
    // The arm falls back to children (it can never convert on this install) —
    // recording variant_assigned anyway would let the bandit permanently bury
    // the arm for what is a missing onFormSubmit prop, not a bad arm.
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith({
      initialSlotConfig: { hero: { kind: 'arms', blocks: { evaluator_v1: FORM_TREE } } },
      initialSlots: { hero: 'evaluator_v1' },
    });
    const el = <AdaptiveSlot id="hero"><button>Start free</button></AdaptiveSlot>;
    const { container, rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el));
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('button')!.textContent).toBe('Start free');
    const exposures = client.track.mock.calls.filter((c) => (c[0] as { eventType?: string })?.eventType === 'variant_assigned');
    expect(exposures.length).toBe(0);
  });

  it('suppresses the exposure when the arm’s ROOT block type is unknown (newer server)', () => {
    // Root-level renderBlocks null = nothing of the arm reached the page.
    // No baseline exposure is reported either: decide didn't assign baseline.
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith({
      initialSlotConfig: {
        hero: { kind: 'arms', blocks: { evaluator_v1: { type: 'hologram', value: 'from the future' } } },
      },
      initialSlots: { hero: 'evaluator_v1' },
    });
    const el = <AdaptiveSlot id="hero"><button>Start free</button></AdaptiveSlot>;
    const { container, rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el));
    expect(container.querySelector('button')!.textContent).toBe('Start free');
    const exposures = client.track.mock.calls.filter((c) => (c[0] as { eventType?: string })?.eventType === 'variant_assigned');
    expect(exposures.length).toBe(0);
  });

  it('a container goal on a form-blocked arm carries no served-arm attribution (no-arm shape)', () => {
    // The visitor converted on baseline children. A goal stamped with the
    // served arm would let close-out's first-pass reconciliation (goal_achieved
    // implies an exposure, CONTRACTS §2) re-mint the suppressed phantom AND
    // credit the blocked arm for baseline's conversion — so `componentGoal` is
    // suppressed. The SESSION goal still records: the visitor did convert, and
    // dropping it loses the conversion from the funnel entirely. Same split
    // `fireFormGoal` already makes for a seeded arm.
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith({
      initialSlotConfig: { hero: { kind: 'arms', blocks: { evaluator_v1: FORM_TREE } } },
      initialSlots: { hero: 'evaluator_v1' },
    });
    const el = (
      <AdaptiveSlot id="hero" goal="signup_click">
        <button>Start free</button>
      </AdaptiveSlot>
    );
    const { container, rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el));
    fireEvent.click(container.querySelector('button')!);
    expect(client.componentGoal).not.toHaveBeenCalled();
    expect(client.goal).toHaveBeenCalledWith('signup_click', expect.objectContaining({
      metadata: { componentId: 'hero', arm: '' },
    }));
  });

  // Regression, prod 2026-09-22 (Bodyshop Manchester). An <Adaptive> switched
  // from `variants` to generated mode registers as a DRAFT slot; until a
  // version is published it resolves to source 'none'. The exposure gate is
  // right to stay shut — there is no arm, so there is no trial — but the goal
  // effect shared that gate, so the CTA's conversion stopped recording too.
  // The component went completely dark for five days and the only signal was
  // an empty funnel.
  it('an UNPUBLISHED slot still records the session conversion', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith({});
    const el = (
      <AdaptiveSlot id="landing_contact_cta" goal="contact_cta_click">
        <a href="/contact">Get in touch</a>
      </AdaptiveSlot>
    );
    const { container, rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el));
    fireEvent.click(container.querySelector('a')!);
    // No arm exists, so nothing may be credited to one.
    expect(client.componentGoal).not.toHaveBeenCalled();
    // But the visitor converted, and the funnel must say so.
    expect(client.goal).toHaveBeenCalledWith('contact_cta_click', expect.objectContaining({
      metadata: { componentId: 'landing_contact_cta', arm: '' },
      weight: 1.0,
      stepIndex: 0,
    }));
  });

  it('a forced (devtools/test) arm still records nothing at all', () => {
    // The one case that must stay fully silent: a forced arm is a preview, not
    // traffic, and recording it would credit a conversion nobody made.
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    // Empty block map: the forced arm has no tree, so the developer's children
    // (with the clickable) stay on screen and the goal listener is the only
    // thing under test.
    applyScenario({ slotConfig: { hero: { kind: 'arms', blocks: {} } }, slots: { hero: 'forced' } });
    try {
      const Wrapper = wrapperWith();
      const el = (
        <AdaptiveSlot id="hero" goal="signup_click">
          <button>Start free</button>
        </AdaptiveSlot>
      );
      const { container, rerender } = render(createElement(Wrapper, null, el));
      rerender(createElement(Wrapper, null, el));
      fireEvent.click(container.querySelector('button')!);
      expect(client.componentGoal).not.toHaveBeenCalled();
      expect(client.goal).not.toHaveBeenCalled();
    } finally {
      resetScenario();
    }
  });
});

describe('baseline text reporting', () => {
  it('sends the wrapper textContent alongside the first registration', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith();
    const el = (
      <AdaptiveSlot id="hero">
        <button>Start free</button>
      </AdaptiveSlot>
    );
    const { rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el)); // client lands after the provider init effect
    const [ids, texts, skeletons] = vi.mocked(client.reportSlots).mock.calls[0]!;
    expect(ids).toEqual(['hero']);
    expect(texts).toEqual({ hero: 'Start free' });
    // The region's structure rides the same first registration (spec
    // 2026-09-23 §4.1): one action node, the button.
    expect((skeletons as Record<string, { nodes: Array<{ role: string }> }>).hero.nodes.map((n) => n.role)).toEqual(['action']);
  });

  it('reportBaselineText={false} registers the id with no text — for slots wrapping personalized content', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith();
    const el = (
      <AdaptiveSlot id="account-banner" reportBaselineText={false}>
        <p>Welcome back, Alice</p>
      </AdaptiveSlot>
    );
    const { rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el));
    expect(client.reportSlots).toHaveBeenCalledWith(['account-banner']);
  });
});

describe('AdaptiveSlot adaptation reveal', () => {
  it('does not animate a slot whose arm was already resolved at mount', () => {
    // The SSR case, and the common one: the arm is in the HTML at first paint,
    // so the page was ALWAYS that way. Animating it would fire on every page
    // load and would be theatre rather than a reveal — the same rule the core
    // module enforces via `previous`.
    const Wrapper = wrapperWith({
      initialSlotConfig: { hero: { kind: 'arms', content: 'Generated headline' } },
      initialSlots: { hero: 'evaluator_v1' },
    });
    const { container } = render(
      <Wrapper>
        <AdaptiveSlot id="hero">baseline</AdaptiveSlot>
      </Wrapper>,
    );
    const slot = container.querySelector('[data-sentient-slot="hero"]')!;
    expect(slot.classList.contains('sentient-revealed')).toBe(false);
    // …and no stylesheet is injected for a page that never revealed anything.
    expect(document.getElementById('sentient-reveal')).toBeNull();
  });

  it('still stamps the arm as provenance without animating', () => {
    const Wrapper = wrapperWith({
      initialSlotConfig: { hero: { kind: 'arms', content: 'Generated headline' } },
      initialSlots: { hero: 'evaluator_v1' },
    });
    const { container } = render(
      <Wrapper>
        <AdaptiveSlot id="hero">baseline</AdaptiveSlot>
      </Wrapper>,
    );
    expect(
      container.querySelector('[data-sentient-slot="hero"]')!.getAttribute('data-sentient-arm'),
    ).toBe('evaluator_v1');
  });
});

describe('<Adaptive> without variants is the slot', () => {
  it('renders the children as the original and asks for the mounted slot', async () => {
    const { Adaptive } = await import('./adaptive.js');
    const requestSlots = vi.fn();
    const client = makeClient({ requestSlots, onSlotsChanged: vi.fn(() => () => undefined) });
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith();
    const el = (
      <Adaptive id="hero-cta" goal="signup_click">
        <a href="/signup">Start free trial</a>
      </Adaptive>
    );
    const { container, rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el)); // client lands after the provider init effect
    expect(container.querySelector('[data-sentient-slot="hero-cta"]')?.textContent).toBe('Start free trial');
    const [ids, texts, extras] = requestSlots.mock.calls[0]!;
    expect(ids).toEqual(['hero-cta']);
    expect(texts).toEqual({ 'hero-cta': 'Start free trial' });
    expect((extras as { render: Record<string, unknown> }).render['hero-cta']).toMatchObject({ forms: false, compose: true, content: true });
  });

  it('renders the served dashboard version in place of the children', async () => {
    const { Adaptive } = await import('./adaptive.js');
    const Wrapper = wrapperWith({
      initialSlotConfig: { hero: { kind: 'arms', content: 'Generated headline' } },
      initialSlots: { hero: 'evaluator_v1' },
    });
    const { container } = render(
      createElement(Wrapper, null, <Adaptive id="hero"><h1>Original</h1></Adaptive>),
    );
    expect(container.textContent).toContain('Generated headline');
    expect(container.textContent).not.toContain('Original');
  });
});

// Native generation phase 1 (spec 2026-09-23 §4.5/§4.6): Rewrite arms land on
// the developer's own elements; a page that can't take one says so up front
// (render caps) or reports drift afterwards — it never silently eats a trial.
describe('Rewrite (edits) arms', () => {
  const CTA = (
    <div className="flex gap-4">
      <a className="btn-primary" href="/contact">Get in touch</a>
      <a className="btn-outline" href="https://api.whatsapp.com/send">WhatsApp photos</a>
    </div>
  );
  const exposuresOf = (client: ReturnType<typeof makeClient>) =>
    client.track.mock.calls.filter((c) => (c[0] as { eventType?: string })?.eventType === 'variant_assigned');

  async function fpOf(node: ReactNode): Promise<string> {
    const { reactFingerprint } = await import('./slot-text.js');
    return reactFingerprint(node)!;
  }

  it('renders the new labels inside the site buttons, with one exposure', async () => {
    const client = makeClient({ reportDrift: vi.fn() });
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith({
      initialSlotConfig: {
        cta: { kind: 'arms', edits: { edits: { nodes: { '0': { text: 'Book a free assessment' } } }, fp: await fpOf(CTA), leafToNode: [0, 1] } },
      },
      initialSlots: { cta: 'unknown_v1' },
    });
    const { container } = render(createElement(Wrapper, null, <AdaptiveSlot id="cta">{CTA}</AdaptiveSlot>));
    expect(container.querySelector('a.btn-primary')!.textContent).toBe('Book a free assessment');
    expect(container.querySelector('a.btn-outline')!.textContent).toBe('WhatsApp photos');
    expect(exposuresOf(client)).toHaveLength(1);
  });

  it('a stale fingerprint renders the original, records no exposure, and reports drift', () => {
    const reportDrift = vi.fn();
    const client = makeClient({ reportDrift });
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith({
      initialSlotConfig: { cta: { kind: 'arms', edits: { edits: { nodes: { '0': { text: 'X' } } }, fp: 'deadbeefdeadbeef', leafToNode: [0, 1] } } },
      initialSlots: { cta: 'unknown_v1' },
    });
    const el = <AdaptiveSlot id="cta">{CTA}</AdaptiveSlot>;
    const { container, rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el)); // client lands after the provider init effect
    expect(container.querySelector('a.btn-primary')!.textContent).toBe('Get in touch');
    expect(exposuresOf(client)).toHaveLength(0);
    expect(reportDrift).toHaveBeenCalledWith('cta', 'deadbeefdeadbeef', expect.any(String), 'fp_mismatch');
  });

  it('an unserved region asks with its fingerprint and caps, and reports its skeleton', async () => {
    const requestSlots = vi.fn();
    const client = makeClient({ requestSlots, onSlotsChanged: vi.fn(() => () => undefined) });
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith();
    const el = <AdaptiveSlot id="cta">{CTA}</AdaptiveSlot>;
    const { rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el));
    const extras = requestSlots.mock.calls[0]![2] as {
      render: Record<string, { fp: string; forms: boolean; content: boolean }>;
      skeletons: Record<string, { leaves: string[] }>;
    };
    expect(extras.render.cta).toEqual({ fp: await fpOf(CTA), forms: false, compose: true, content: false });
    expect(extras.skeletons.cta.leaves).toEqual(['Get in touch', 'WhatsApp photos']);
  });

  // Since 0.35.1: the DOM capture is still sent, marked non-editable, so the
  // region can be REDESIGNED (replaced whole) — never edited per element.
  it('text behind a prop is captured non-editable, never addressed for edits', () => {
    const requestSlots = vi.fn();
    const client = makeClient({ requestSlots, onSlotsChanged: vi.fn(() => () => undefined) });
    mockedInit.mockReturnValue(client as never);
    function Cta({ label }: { label: string }) {
      return <button>{label}</button>;
    }
    const Wrapper = wrapperWith();
    const el = <AdaptiveSlot id="cta"><Cta label="Book now" /></AdaptiveSlot>;
    const { rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el));
    const extras = requestSlots.mock.calls[0]![2] as {
      skeletons: Record<string, { editable?: boolean; leaves: string[]; fp: string; nodes: Array<{ restylable: boolean }> }>;
      render: Record<string, { fp?: string }>;
    };
    const sk = extras.skeletons.cta!;
    expect(sk.editable).toBe(false);
    expect(sk.leaves).toEqual(['Book now']);
    expect(sk.nodes.every((n) => n.restylable === false)).toBe(true);
    // The page's declared fingerprint never matches the capture, so no Rewrite
    // arm bound to it can be drawn here (CONTRACTS §2).
    expect(extras.render.cta!.fp).not.toBe(sk.fp);
  });

  it('a component with no props (the Bodyshop CTA shape) is captured too', () => {
    const requestSlots = vi.fn();
    const client = makeClient({ requestSlots, onSlotsChanged: vi.fn(() => () => undefined) });
    mockedInit.mockReturnValue(client as never);
    function CtaButtons() {
      return (
        <div className="flex gap-4">
          <a href="/contact" className="px-8 bg-blue-600">Get in touch</a>
          <a href="https://api.whatsapp.com/send" className="px-8 border">WhatsApp photos</a>
        </div>
      );
    }
    const Wrapper = wrapperWith();
    const el = <AdaptiveSlot id="cta"><CtaButtons /></AdaptiveSlot>;
    const { rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el));
    const sk = (requestSlots.mock.calls[0]![2] as { skeletons: Record<string, { editable?: boolean; leaves: string[]; nodes: Array<{ role: string; href?: string }> }> }).skeletons.cta!;
    expect(sk.editable).toBe(false);
    expect(sk.leaves).toEqual(['Get in touch', 'WhatsApp photos']);
    expect(sk.nodes.map((n) => [n.role, n.href])).toEqual([['action', '/contact'], ['action', 'https://api.whatsapp.com/send']]);
  });

  it('a preview (override) with a stale fingerprint reports no drift', () => {
    const reportDrift = vi.fn();
    const client = makeClient({ reportDrift });
    mockedInit.mockReturnValue(client as never);
    applyScenario({
      slotConfig: { cta: { kind: 'arms', edits: { edits: { nodes: { '0': { text: 'X' } } }, fp: 'deadbeefdeadbeef', leafToNode: [0, 1] } } },
      slots: { cta: 'unknown_v1' },
    });
    const el = <AdaptiveSlot id="cta">{CTA}</AdaptiveSlot>;
    const Wrapper = wrapperWith();
    const { rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el));
    expect(reportDrift).not.toHaveBeenCalled();
    resetScenario();
  });
});

describe('Refresh from page (trusted skeleton overwrite)', () => {
  it('forces the original, captures the region inside the slot, and posts it with the editor token', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchSpy);
    // The editor session is exchanged from a fragment code (E1); here the
    // tab already holds the exchanged token.
    (await import('./editor-session.js')).resetEditorSessionForTests();
    sessionStorage.setItem('__snt_editor_token', 'tok123');
    window.history.replaceState(null, '', '/?sentient_refresh_region=cta');
    const { maybeStartCellPreview } = await import('./cell-preview.js');
    maybeStartCellPreview('https://api.example.com/v1');
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith({
      // A served version that must NOT be what gets captured.
      initialSlotConfig: { cta: { kind: 'arms', content: 'Served copy' } },
      initialSlots: { cta: 'unknown_v1' },
    });
    const el = (
      <AdaptiveSlot id="cta">
        <div className="flex">
          <a href="/contact">Get in touch</a>
          <a href="https://api.whatsapp.com/send">WhatsApp photos</a>
        </div>
      </AdaptiveSlot>
    );
    const { rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el));
    // The post waits on the (async) editor session.
    await vi.waitFor(() =>
      expect(fetchSpy.mock.calls.find(([u]) => String(u).endsWith('/editor/region-skeleton'))).toBeDefined());
    const post = fetchSpy.mock.calls.find(([u]) => String(u).endsWith('/editor/region-skeleton'));
    sessionStorage.clear();
    expect((post![1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok123' });
    const body = JSON.parse(String((post![1] as RequestInit).body));
    expect(body.slotId).toBe('cta');
    expect(body.skeleton.leaves).toEqual(['Get in touch', 'WhatsApp photos']);
    window.history.replaceState(null, '', '/');
    resetScenario();
    vi.unstubAllGlobals();
  });
});

describe('hybrid <Adaptive> (authored arms)', () => {
  it('renders the served authored arm from variants, including server-side', () => {
    const Wrapper = wrapperWith({ initialSlotConfig: { hero: { kind: 'arms' } }, initialSlots: { hero: 'authored.quote' } });
    const el = (
      <AdaptiveSlot id="hero" variants={{ quote: <a className="q">Get a quote</a> }}>
        <a className="b">Get in touch</a>
      </AdaptiveSlot>
    );
    const { container } = render(createElement(Wrapper, null, el));
    expect(container.querySelector('a.q')!.textContent).toBe('Get a quote');
    expect(container.querySelector('a.b')).toBeNull();
    expect(renderToString(createElement(Wrapper, null, el))).toContain('Get a quote');
  });

  it('renders children and records nothing while the server blocks a legacy id', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith({ initialSlotConfig: { hero: { kind: 'arms', blocked: 'variant_history' } } });
    const el = (
      <AdaptiveSlot id="hero" variants={{ quote: <b>q</b> }}>
        <b className="base">base</b>
      </AdaptiveSlot>
    );
    const { container, rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el));
    expect(container.querySelector('b.base')).not.toBeNull();
    const exposures = client.track.mock.calls.filter((c) => (c[0] as { eventType?: string })?.eventType === 'variant_assigned');
    expect(exposures).toHaveLength(0);
  });

  it('reports what a served authored arm rendered', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith({ initialSlotConfig: { hero: { kind: 'arms' } }, initialSlots: { hero: 'authored.quote' } });
    const el = (
      <AdaptiveSlot id="hero" variants={{ quote: <a href="/q">Get a quote</a> }}>
        <a href="/c">Get in touch</a>
      </AdaptiveSlot>
    );
    const { rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el));
    const call = vi.mocked(client.reportSlots).mock.calls.find((c) => c[3] !== undefined);
    expect(call![3]).toMatchObject({ hero: [{ key: 'quote', text: 'Get a quote' }] });
  });
});

describe('Redesign (compose) arms', () => {
  const vocabulary = {
    rev: 'r',
    images: [],
    entries: [
      { id: 'section-dark', role: 'section', classes: 'bg-slate-900 py-24', computed: {}, seen: { url: '/', count: 1, at: '' }, source: 'editor' },
      { id: 'heading-1', role: 'heading-1', classes: 'text-4xl font-bold', computed: {}, seen: { url: '/', count: 1, at: '' }, source: 'editor' },
    ],
  };
  const slotConfig = {
    hero: { kind: 'arms', compose: { unknown_v3: { surface: { like: 'section-dark' }, tree: { type: 'heading', level: 1, like: 'heading-1', value: 'Insurance repairs, done properly' } } } },
  };

  it('renders the composed section on the site surface, instead of children, with one exposure — and SSR agrees', () => {
    const client = makeClient();
    mockedInit.mockReturnValue(client as never);
    const Wrapper = wrapperWith({ initialSlotConfig: slotConfig, initialSlots: { hero: 'unknown_v3' }, initialVocabulary: vocabulary });
    const el = (
      <AdaptiveSlot id="hero">
        <h1 className="orig">Bodyshop Manchester</h1>
      </AdaptiveSlot>
    );
    const { container, rerender } = render(createElement(Wrapper, null, el));
    rerender(createElement(Wrapper, null, el));
    expect(container.querySelector('div.bg-slate-900 > h1.text-4xl')!.textContent).toBe('Insurance repairs, done properly');
    expect(container.querySelector('h1.orig')).toBeNull();
    const exposures = client.track.mock.calls.filter((c) => (c[0] as { eventType?: string })?.eventType === 'variant_assigned');
    expect(exposures).toHaveLength(1);
    const ssr = renderToString(createElement(Wrapper, null, el));
    expect(ssr).toContain('<div class="bg-slate-900 py-24"><h1 class="text-4xl font-bold">Insurance repairs, done properly</h1></div>');
  });
});

// Native generation phase 2: "Preview on your site" for a redesigned section
// renders it with the site's own class lists, served with the preview.
describe('on-site preview of a redesigned section', () => {
  it('renders the composed section with the borrowed site classes', async () => {
    document.getElementById('sentient-cell-preview-bar')?.remove();
    const at = '2026-09-20T00:00:00.000Z';
    const entry = (id: string, role: string, classes: string) => ({ id, role, classes, computed: {}, seen: { url: '/', count: 1, at }, source: 'editor' });
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'review', slotName: 'Hero', personaDisplay: 'everyone', content: null, blocks: null,
        compose: { surface: { like: 'section' }, tree: { type: 'button', label: 'Get a quote', href: '/quote', like: 'button-primary' } },
        vocabulary: { rev: 'r', images: [], entries: [entry('section', 'section', 'bg-slate-900 py-24'), entry('button-primary', 'button-primary', 'btn btn-blue')] },
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    (await import('./editor-session.js')).resetEditorSessionForTests();
    sessionStorage.setItem('__snt_editor_token', 'tok');
    window.history.replaceState(null, '', '/?sentient_preview_cell=hero~unknown');
    const { maybeStartCellPreview } = await import('./cell-preview.js');
    maybeStartCellPreview('https://api.example.com/v1');
    await vi.waitFor(() => expect((window as unknown as Record<string, unknown>).__sentient_vocabulary_override).toBeDefined());
    await new Promise((r) => setTimeout(r, 0));
    sessionStorage.clear();
    mockedInit.mockReturnValue(makeClient() as never);
    const Wrapper = wrapperWith();
    const { container } = render(createElement(Wrapper, null, <AdaptiveSlot id="hero"><p>Original hero</p></AdaptiveSlot>));
    expect(container.querySelector('.btn-blue')?.textContent).toBe('Get a quote');
    expect(container.querySelector('.bg-slate-900')).not.toBeNull();
    expect(container.textContent).not.toContain('Original hero');
    window.history.replaceState(null, '', '/');
    delete (window as unknown as Record<string, unknown>).__sentient_slot_config_overrides;
    delete (window as unknown as Record<string, unknown>).__sentient_slot_overrides;
    delete (window as unknown as Record<string, unknown>).__sentient_vocabulary_override;
    document.getElementById('sentient-cell-preview-bar')?.remove();
    resetScenario();
    vi.unstubAllGlobals();
  });
});
