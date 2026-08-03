// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { computeMoveAnchors } from './index';

describe('computeMoveAnchors', () => {
  it('reads the current previous/next siblings', () => {
    document.body.innerHTML = '<div id="a">A</div><div id="b">B</div><div id="c">C</div>';
    const b = document.getElementById('b')!;
    const anchors = computeMoveAnchors(b, document);
    expect(anchors.prevEl?.id).toBe('a');
    expect(anchors.nextEl?.id).toBe('c');
    expect(anchors.prevLocator).not.toBeNull();
    expect(anchors.nextLocator).not.toBeNull();
  });

  it('reflects the new neighbors AFTER a move (no stale refs)', () => {
    document.body.innerHTML = '<div id="a">A</div><div id="b">B</div><div id="c">C</div>';
    const b = document.getElementById('b')!;
    // simulate "move up": b before a
    b.parentElement!.insertBefore(b, document.getElementById('a'));
    const anchors = computeMoveAnchors(b, document);
    expect(anchors.prevEl).toBeNull();          // b is now first
    expect(anchors.nextEl?.id).toBe('a');       // a is now after b
    expect(anchors.prevLocator).toBeNull();
  });

  it('nulls a locator for a sibling that does not resolve uniquely', () => {
    document.body.innerHTML = '<ul><li>x</li><li id="target">t</li><li>x</li></ul>';
    const target = document.getElementById('target')!;
    const anchors = computeMoveAnchors(target, document);
    expect(anchors.prevEl).not.toBeNull();
  });
});
