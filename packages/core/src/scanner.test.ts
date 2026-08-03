import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDOMScanner } from './scanner';

describe('createDOMScanner', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('scan returns empty result in SSR', async () => {
    vi.stubGlobal('window', undefined);
    const scanner = createDOMScanner();
    const result = await scanner.scan();
    expect(result.nodes).toEqual([]);
  });

  it('scans data-sentient-id elements', async () => {
    document.body.innerHTML = `
      <div data-sentient-id="hero-1" data-sentient-type="hero">
        <h1>Welcome</h1>
      </div>
    `;

    const scanner = createDOMScanner();
    const result = await scanner.scan();
    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    const hero = result.nodes.find((n) => n.componentId === 'hero-1');
    expect(hero?.semanticType).toBe('hero');
    expect(hero?.headingText).toBe('Welcome');
    scanner.destroy();
  });

  it('getProminenceScore returns value between 0 and 1', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const scanner = createDOMScanner();
    const score = scanner.getProminenceScore(el);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    scanner.destroy();
  });

  it('observe fires when matching node added', async () => {
    const scanner = createDOMScanner();
    const added = vi.fn();
    scanner.observe(added);

    const section = document.createElement('section');
    section.setAttribute('data-sentient-id', 'dynamic-1');
    section.setAttribute('aria-label', 'Dynamic section');
    document.body.appendChild(section);

    await vi.waitFor(() => {
      expect(added).toHaveBeenCalled();
    });

    const event = added.mock.calls[0][0];
    expect(
      event.nodes.some((n: { componentId: string }) => n.componentId === 'dynamic-1'),
    ).toBe(true);
    scanner.destroy();
  });

  it('destroy disconnects observer without throwing', () => {
    const scanner = createDOMScanner();
    scanner.observe(() => undefined);
    expect(() => scanner.destroy()).not.toThrow();
  });

  it('getProminenceScore clamps to [0,1] for an element above the viewport top', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    // Element scrolled above the fold: top < 0, bottom > innerHeight.
    el.getBoundingClientRect = () =>
      ({ top: -200, bottom: window.innerHeight + 500, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    const scanner = createDOMScanner();
    const score = scanner.getProminenceScore(el);
    // distanceFromTop is max(top,0)=0 → inverseDistance maxes out, score stays in range.
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    scanner.destroy();
  });

  it('getProminenceScore returns 0.5 fallback when getComputedStyle throws', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const orig = window.getComputedStyle;
    vi.stubGlobal('getComputedStyle', () => { throw new Error('boom'); });

    const scanner = createDOMScanner();
    expect(scanner.getProminenceScore(el)).toBe(0.5);
    scanner.destroy();
    vi.stubGlobal('getComputedStyle', orig);
  });

  it('scan() falls back to direct run when requestIdleCallback is unavailable', async () => {
    const orig = (globalThis as Record<string, unknown>).requestIdleCallback;
    // Remove requestIdleCallback so the scanner takes the synchronous run() path.
    vi.stubGlobal('requestIdleCallback', undefined);

    document.body.innerHTML = `<div data-sentient-id="x-1" data-sentient-type="hero"><h1>Hi</h1></div>`;
    const scanner = createDOMScanner();
    const result = await scanner.scan();
    expect(result.nodes.some((n) => n.componentId === 'x-1')).toBe(true);
    scanner.destroy();

    vi.stubGlobal('requestIdleCallback', orig);
  });

  it('detectStructuralEdges dedups: nested registered components produce one parent→child edge', async () => {
    document.body.innerHTML = `
      <section data-sentient-id="parent-1" aria-label="p">
        <div data-sentient-id="child-1" data-sentient-type="cta"></div>
      </section>
    `;
    const scanner = createDOMScanner();
    const { edges } = await scanner.scan();
    const parentChild = edges.filter(
      (e) => e.fromComponentId === 'parent-1' && e.toComponentId === 'child-1',
    );
    // Despite the seen-set logic running across both registered + structural passes,
    // exactly one parent→child structural edge is emitted (no duplicates).
    expect(parentChild).toHaveLength(1);
    expect(parentChild[0].weight).toBe(0.6);
    scanner.destroy();
  });

  it('gives id-less aria-labelled siblings distinct componentIds (no node loss)', async () => {
    // Two <section aria-label> with no data-sentient-id / id. The old fallback
    // returned tagName.toLowerCase() for both → identical componentId → the graph
    // Map keyed by componentId silently dropped the second one.
    document.body.innerHTML = `
      <section aria-label="Pricing">
        <h2>Pricing</h2>
      </section>
      <section aria-label="Testimonials">
        <h2>What people say</h2>
      </section>
    `;
    const scanner = createDOMScanner();
    const { nodes } = await scanner.scan();
    const sections = nodes.filter((n) => n.ariaLabel === 'Pricing' || n.ariaLabel === 'Testimonials');
    expect(sections).toHaveLength(2);
    const ids = sections.map((n) => n.componentId);
    // Distinct ids — the two sections don't collide into a single graph node.
    expect(new Set(ids).size).toBe(2);
    scanner.destroy();
  });

  it('synthesizes a stable componentId across re-scans for the same id-less element', async () => {
    document.body.innerHTML = `<section aria-label="Pricing"><h2>Pricing</h2></section>`;
    const scanner1 = createDOMScanner();
    const first = (await scanner1.scan()).nodes.find((n) => n.ariaLabel === 'Pricing')!.componentId;
    scanner1.destroy();
    // Same DOM → same synthesized id, so persisted graph nodes still line up.
    const scanner2 = createDOMScanner();
    const second = (await scanner2.scan()).nodes.find((n) => n.ariaLabel === 'Pricing')!.componentId;
    scanner2.destroy();
    expect(second).toBe(first);
  });

  it('observe detects a parent→child edge when a child is inserted under an already-scanned parent', async () => {
    document.body.innerHTML = `
      <section data-sentient-id="parent-existing" aria-label="p"></section>
    `;
    const scanner = createDOMScanner();
    // Initial scan registers the parent.
    await scanner.scan();

    const added = vi.fn();
    scanner.observe(added);

    // Insert a matching child UNDER the already-scanned parent.
    const parent = document.querySelector('[data-sentient-id="parent-existing"]')!;
    const child = document.createElement('div');
    child.setAttribute('data-sentient-id', 'child-late');
    child.setAttribute('aria-label', 'late child');
    parent.appendChild(child);

    await vi.waitFor(() => expect(added).toHaveBeenCalled());

    const event = added.mock.calls[added.mock.calls.length - 1][0];
    const parentChild = event.edges.filter(
      (e: { fromComponentId: string; toComponentId: string }) =>
        e.fromComponentId === 'parent-existing' && e.toComponentId === 'child-late',
    );
    // The parent was scanned in a prior pass, not in this mutation — incremental
    // detection must still produce the parent→child structural edge.
    expect(parentChild).toHaveLength(1);
    expect(parentChild[0].weight).toBe(0.6);
    scanner.destroy();
  });

  it('caps sibling-edge fan-out for a very large co-located group', async () => {
    // 200 id-less aria-labelled sections share one parent. Uncapped, sibling
    // detection is O(n²) × 2 → ~80k edges. The cap keeps it bounded.
    const cells = Array.from({ length: 200 }, (_, i) => `<section aria-label="cell-${i}"></section>`).join('');
    document.body.innerHTML = `<main data-sentient-id="grid">${cells}</main>`;
    const scanner = createDOMScanner();
    const { edges } = await scanner.scan();
    // Well under the uncapped ~80k; comfortably below the server's 2000-edge limit.
    expect(edges.length).toBeLessThanOrEqual(2000);
    scanner.destroy();
  });

  it('reactComponentName is undefined when __reactFiber lacks a usable type.name', async () => {
    document.body.innerHTML = `<div data-sentient-id="rc-1" data-sentient-type="hero"></div>`;
    const el = document.querySelector('[data-sentient-id="rc-1"]')! as HTMLElement & Record<string, unknown>;
    // Fiber present but type has no name/displayName → extraction returns undefined.
    el['__reactFiber$abc'] = { type: {} };

    const scanner = createDOMScanner();
    const { nodes } = await scanner.scan();
    const node = nodes.find((n) => n.componentId === 'rc-1');
    expect(node?.reactComponentName).toBeUndefined();
    scanner.destroy();
  });

  it('reactComponentName extracts displayName from __reactFiber type', async () => {
    document.body.innerHTML = `<div data-sentient-id="rc-2" data-sentient-type="hero"></div>`;
    const el = document.querySelector('[data-sentient-id="rc-2"]')! as HTMLElement & Record<string, unknown>;
    el['__reactFiber$xyz'] = { type: { displayName: 'PricingCard' } };

    const scanner = createDOMScanner();
    const { nodes } = await scanner.scan();
    const node = nodes.find((n) => n.componentId === 'rc-2');
    expect(node?.reactComponentName).toBe('PricingCard');
    scanner.destroy();
  });

  describe('semantic type normalization + heuristic fallback', () => {
    async function scanOne(html: string, id: string): Promise<string | undefined> {
      document.body.innerHTML = html;
      const scanner = createDOMScanner();
      const { nodes } = await scanner.scan();
      scanner.destroy();
      return nodes.find((n) => n.componentId === id)?.semanticType;
    }

    it('normalizes an invalid data-sentient-type through the heuristic', async () => {
      const type = await scanOne(
        `<section data-sentient-id="s-1" data-sentient-type="bogus" id="pricing-table"><h2>Simple pricing</h2></section>`,
        's-1',
      );
      expect(type).toBe('pricing');
    });

    it('accepts a valid role as semantic type', async () => {
      const type = await scanOne(
        `<div data-sentient-id="s-2" role="navigation">Home Docs</div>`,
        's-2',
      );
      expect(type).toBe('navigation');
    });

    it('falls back to the heuristic for untagged elements', async () => {
      const type = await scanOne(
        `<section data-sentient-id="s-3" class="pricing"><h2>Plans</h2></section>`,
        's-3',
      );
      expect(type).toBe('pricing');
    });

    it('still returns generic when nothing matches', async () => {
      const type = await scanOne(
        `<div data-sentient-id="s-4"><p>Some paragraph of prose that carries no strong signal about its role at all whatsoever in this element.</p></div>`,
        's-4',
      );
      expect(type).toBe('generic');
    });
  });
});
