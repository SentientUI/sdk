// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { REVEAL_MS, resetRevealStyles, reveal } from './reveal';

function el(text = 'before'): HTMLElement {
  const node = document.createElement('p');
  node.textContent = text;
  document.body.appendChild(node);
  return node;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  resetRevealStyles();
});

describe('reveal — rule 1: never a cloak', () => {
  it('never animates from zero opacity', () => {
    // The 2026-09-07 decision: nothing is hidden and then revealed. A visitor
    // arriving mid-animation must read real content, and a failed script must
    // leave a page that was never hidden.
    const node = el();
    node.textContent = 'after';
    reveal(node, { previous: 'before' });
    const css = document.getElementById('sentient-reveal')!.textContent!;
    expect(css).toMatch(/from\{opacity:\.55/);
    expect(css).not.toMatch(/opacity:\s*0[;,}]/);
  });

  it('never sets visibility or display', () => {
    const node = el();
    node.textContent = 'after';
    reveal(node, { previous: 'before' });
    const css = document.getElementById('sentient-reveal')!.textContent!;
    expect(css).not.toMatch(/visibility|display:\s*none/);
    expect(node.style.visibility).toBe('');
  });
});

describe('reveal — rule 2: only on a real change', () => {
  it('does nothing when the text is unchanged', () => {
    // A return visitor's arm is applied pre-paint, so the page was ALWAYS that
    // way. Animating it would be theatre, and would fire on every page load.
    const node = el('same');
    expect(reveal(node, { previous: 'same' })).toBe(false);
    expect(node.className).toBe('');
    expect(document.getElementById('sentient-reveal')).toBeNull();
  });

  it('animates when the text did change', () => {
    const node = el('before');
    node.textContent = 'after';
    expect(reveal(node, { previous: 'before' })).toBe(true);
    expect(node.classList.contains('sentient-revealed')).toBe(true);
  });

  it('animates when the caller did not track the previous text', () => {
    // `undefined` is the caller asserting a change it did not measure; an
    // explicit equal value is the caller saying there was none.
    expect(reveal(el(), {})).toBe(true);
  });
});

describe('reveal — rule 3: reduced motion wins', () => {
  it('defines the animation ONLY inside a no-preference query', () => {
    // Not a config option and not overridable. Defining the keyframes globally
    // and disabling them under `reduce` would still leave the class applying a
    // transform where the query is mis-reported; this way the rule does not
    // exist for those users at all.
    reveal(el(), {});
    const css = document.getElementById('sentient-reveal')!.textContent!;
    expect(css.startsWith('@media (prefers-reduced-motion: no-preference)')).toBe(true);
    expect(css.indexOf('@keyframes')).toBeGreaterThan(css.indexOf('no-preference'));
  });
});

describe('reveal — provenance', () => {
  it('records the arm and persona as data, never as visible copy', () => {
    // Telling a customer's visitors they are being personalized is the
    // customer's decision about their own site, not a default we ship.
    const node = el();
    reveal(node, { arm: 'urgent_v2', persona: 'admin' });
    expect(node.getAttribute('data-sentient-arm')).toBe('urgent_v2');
    expect(node.getAttribute('data-sentient-persona')).toBe('admin');
    expect(node.textContent).not.toMatch(/admin|urgent/);
  });

  it('records provenance even when no motion runs', () => {
    // A pre-paint apply still wants to say which arm it applied.
    const node = el('same');
    expect(reveal(node, { previous: 'same', arm: 'a1' })).toBe(false);
    expect(node.getAttribute('data-sentient-arm')).toBe('a1');
  });
});

describe('reveal — hygiene', () => {
  it('injects exactly one stylesheet however many times it runs', () => {
    for (let i = 0; i < 5; i++) reveal(el(), {});
    expect(document.querySelectorAll('#sentient-reveal')).toHaveLength(1);
  });

  it('replays rather than no-ops when an element is revealed twice', () => {
    // A persona upgrade landing on top of a first decide is a second real
    // change and should read as one.
    const node = el();
    reveal(node, {});
    node.classList.remove('sentient-revealed');
    reveal(node, {});
    expect(node.classList.contains('sentient-revealed')).toBe(true);
  });

  it('cleans the class off when the animation ends', () => {
    const node = el();
    reveal(node, {});
    node.dispatchEvent(new Event('animationend'));
    expect(node.classList.contains('sentient-revealed')).toBe(false);
  });

  it('stays inside the 200-400ms the spec asks for', () => {
    expect(REVEAL_MS).toBeGreaterThanOrEqual(200);
    expect(REVEAL_MS).toBeLessThanOrEqual(400);
  });

  it('does not throw without a document', () => {
    expect(reveal({} as Element, {})).toBe(false);
  });
});
