import { describe, it, expect, beforeEach } from 'vitest';
import { MAX_SKELETON_NODES } from './region-skeleton.js';
import { captureRegionSkeleton, skeletonFingerprint, normalizeLeafText } from './region-capture.js';

function mount(html: string): Element {
  document.body.innerHTML = `<div id="r">${html}</div>`;
  return document.getElementById('r')!;
}

describe('captureRegionSkeleton', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('Bodyshop CTA: two action nodes in one group, links normalized, query dropped', () => {
    const r = mount(
      '<div class="flex gap-4"><a class="px-8 bg-blue-600 cta-primary" href="/contact">Get in touch</a>' +
      '<a class="px-8 border" href="https://api.whatsapp.com/send?phone=441613839952">WhatsApp photos</a></div>',
    );
    const out = captureRegionSkeleton(r);
    expect(out.skeleton).not.toBeNull();
    const s = out.skeleton!;
    expect(s.nodes.map((n) => [n.tag, n.role, n.text])).toEqual([['a', 'action', 'Get in touch'], ['a', 'action', 'WhatsApp photos']]);
    expect(s.nodes[0]!.href).toBe('/contact');
    expect(s.nodes[1]!.href).toBe('https://api.whatsapp.com/send');
    expect(s.nodes[0]!.group).toBe(s.nodes[1]!.group);
    expect(s.leafToNode).toEqual([0, 1]);
    expect(s.fp).toBe(skeletonFingerprint(['Get in touch', 'WhatsApp photos']));
  });

  it('icon button: svg untouched, one action node', () => {
    const r = mount('<button class="btn"><svg><path/></svg> Book now </button>');
    const s = captureRegionSkeleton(r).skeleton!;
    expect(s.nodes).toHaveLength(1);
    expect(s.nodes[0]!.role).toBe('action');
    expect(s.leaves).toEqual(['Book now']);
  });

  it('inline emphasis merges into its heading (one node, two leaves)', () => {
    const r = mount('<h2 class="t">Save <em>today</em></h2>');
    const s = captureRegionSkeleton(r).skeleton!;
    expect(s.nodes).toHaveLength(1);
    expect(s.nodes[0]).toMatchObject({ role: 'heading', level: 2, text: 'Save today' });
    expect(s.leafToNode).toEqual([0, 0]);
  });

  it('an action wins over a nearer block ancestor', () => {
    const r = mount('<a href="/x"><span style="display:block">Book</span></a>');
    expect(captureRegionSkeleton(r).skeleton!.nodes[0]!.role).toBe('action');
  });

  it('rejects > MAX_SKELETON_NODES and empty regions', () => {
    const many = Array.from({ length: MAX_SKELETON_NODES + 1 }, (_, i) => `<p>t${i}</p>`).join('');
    expect(captureRegionSkeleton(mount(many))).toEqual({ skeleton: null, reason: 'too_large' });
    expect(captureRegionSkeleton(mount('<div><svg></svg></div>'))).toEqual({ skeleton: null, reason: 'empty' });
  });

  it('skips script/style/template text', () => {
    const r = mount('<p>Hi</p><script>var x = 1</script><style>.a{}</style><template>no</template>');
    expect(captureRegionSkeleton(r).skeleton!.leaves).toEqual(['Hi']);
  });

  it('ambient background resolves through transparent ancestors', () => {
    document.body.innerHTML = '<section style="background-color: rgb(15, 23, 42)"><div><div id="r"><p>Hi</p></div></div></section>';
    const s = captureRegionSkeleton(document.getElementById('r')!).skeleton!;
    expect(s.root.ambientBg).toBe('rgb(15, 23, 42)');
  });

  it('fingerprint is stable across captures and changes on any text change', () => {
    const a = captureRegionSkeleton(mount('<a href="/a">One</a>')).skeleton!.fp;
    const b = captureRegionSkeleton(mount('<a href="/a">One</a>')).skeleton!.fp;
    const c = captureRegionSkeleton(mount('<a href="/a">Two</a>')).skeleton!.fp;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(normalizeLeafText('  a \n b ')).toBe('a b');
  });
});
