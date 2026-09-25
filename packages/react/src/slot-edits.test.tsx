import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { type ReactNode } from 'react';
import { applyEdits, reactLeafTexts, reactFingerprint, annotateSkeletonForReact } from './slot-text.js';
import { captureRegionSkeleton, skeletonFingerprint } from '@sentientui/core/region';

const CTA = (
  <div className="flex gap-4">
    <a className="btn-primary" href="/contact">Get in touch</a>
    <a className="btn-outline" href="https://api.whatsapp.com/send">WhatsApp photos</a>
  </div>
);

function dom(node: ReactNode): HTMLElement {
  return render(<div data-testid="r">{node}</div>).getByTestId('r');
}

describe('React edits', () => {
  it('leaf texts and fingerprint match the DOM capture (parity)', () => {
    const root = dom(CTA);
    const s = captureRegionSkeleton(root).skeleton!;
    expect(reactLeafTexts(CTA)).toEqual(s.leaves);
    expect(reactFingerprint(CTA)).toBe(s.fp);
    expect(annotateSkeletonForReact(s, CTA)).not.toBeNull();
  });

  it('rewrites both labels in place, keeping classes and hrefs', () => {
    const out = applyEdits(CTA, { nodes: { '0': { text: 'Book a free assessment' }, '1': { text: 'Send photos on WhatsApp' } } }, [0, 1]);
    const root = dom(out);
    expect(root.querySelector('a.btn-primary')!.textContent).toBe('Book a free assessment');
    expect(root.querySelector('a.btn-outline')!.getAttribute('href')).toBe('https://api.whatsapp.com/send');
  });

  it('emphasis swap + reorder: WhatsApp becomes the filled first button', () => {
    const out = applyEdits(CTA, { nodes: { '0': { like: 1 }, '1': { like: 0 } }, order: { '0': [1, 0] } }, [0, 1]);
    const links = dom(out).querySelectorAll('a');
    expect(links[0]!.className).toBe('btn-primary');
    expect(links[0]!.textContent).toBe('WhatsApp photos');
    expect(links[1]!.className).toBe('btn-outline');
  });

  it('hides a node', () => {
    const out = applyEdits(CTA, { nodes: { '1': { hidden: true } } }, [0, 1]);
    expect(dom(out).querySelectorAll('a')).toHaveLength(1);
  });

  it('multi-leaf node: first leaf gets the text, the rest blank, inline element kept', () => {
    const h = <h2>Save <em>today</em></h2>;
    expect(dom(applyEdits(h, { nodes: { '0': { text: 'Book this week' } } }, [0, 0])).textContent).toBe('Book this week');
  });

  it('returns null when the tree no longer matches (leaf count) or like cannot restyle', () => {
    expect(applyEdits(<a>Only one</a>, { nodes: { '1': { text: 'x' } } }, [0, 1])).toBeNull();
    function Opaque({ children }: { children: ReactNode }) { return <a className="x">{children}</a>; }
    const t = <div><Opaque>A</Opaque><a className="y">B</a></div>;
    expect(applyEdits(t, { nodes: { '0': { like: 1 } } }, [0, 1])).toBeNull();
  });

  it('annotate: parity failure (label prop) → null', () => {
    function Cta({ label }: { label: string }) { return <button>{label}</button>; }
    const tree = <Cta label="Book now" />;
    const s = captureRegionSkeleton(dom(tree)).skeleton!;
    expect(annotateSkeletonForReact(s, tree)).toBeNull();
    expect(skeletonFingerprint(['Book now'])).toBe(s.fp);
  });
});
