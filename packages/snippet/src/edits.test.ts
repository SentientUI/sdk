import { describe, it, expect, beforeEach } from 'vitest';
import { captureRegionSkeleton } from '@sentientui/core/region';
import { applyEdits } from './edits';

const HTML = '<div id="r"><div class="flex"><a class="btn-primary" href="/contact">Get in touch</a><a class="btn-outline" href="https://api.whatsapp.com/send">WhatsApp photos</a></div></div>';

describe('snippet applyEdits', () => {
  beforeEach(() => { document.body.innerHTML = HTML; });
  const el = () => document.getElementById('r')!;
  const served = () => { const s = captureRegionSkeleton(el()).skeleton!; return { fp: s.fp, leafToNode: s.leafToNode }; };

  it('rewrites labels in place', () => {
    const sk = served();
    expect(applyEdits(el(), { nodes: { '0': { text: 'Book a free assessment' } } }, sk)).toBe('applied');
    expect(document.querySelector('a.btn-primary')!.textContent).toBe('Book a free assessment');
  });
  it('swap + reorder', () => {
    const sk = served();
    applyEdits(el(), { nodes: { '0': { like: 1 }, '1': { like: 0 } }, order: { '0': [1, 0] } }, sk);
    const a = document.querySelectorAll('#r a');
    expect(a[0]!.className).toBe('btn-primary');
    expect(a[0]!.textContent).toBe('WhatsApp photos');
  });
  it('mismatch touches nothing', () => {
    expect(applyEdits(el(), { nodes: { '0': { text: 'x' } } }, { fp: 'deadbeefdeadbeef', leafToNode: [0, 1] })).toBe('mismatch');
    expect(document.querySelector('a.btn-primary')!.textContent).toBe('Get in touch');
  });
  it('reapply is idempotent', () => {
    const sk = served();
    const e = { nodes: { '0': { text: 'A' } }, order: { '0': [1, 0] } };
    applyEdits(el(), e, sk); const once = el().innerHTML;
    applyEdits(el(), e, sk); expect(el().innerHTML).toBe(once);
  });
});
