import { describe, it, expect, beforeEach } from 'vitest';
import { classifyFeatures, classifySection, SEMANTIC_TYPES, type SectionFeatures } from './classify';

beforeEach(() => { document.body.innerHTML = ''; });

function make(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

describe('classifySection', () => {
  it('classifies pricing/faq/features by keyword', () => {
    expect(classifySection(make('<section id="pricing"><h2>Simple pricing</h2></section>'))).toBe('pricing');
    expect(classifySection(make('<section><h2>Frequently asked questions</h2></section>'))).toBe('faq');
    expect(classifySection(make('<section class="features"><h2>What you get</h2></section>'))).toBe('features');
  });

  it('classifies social proof and trust', () => {
    expect(classifySection(make('<section><h2>Trusted by 5,000 teams</h2></section>'))).toBe('social_proof');
    expect(classifySection(make('<section><h3>SOC2 & GDPR compliant</h3></section>'))).toBe('trust');
  });

  it('treats nav and footer as navigation', () => {
    expect(classifySection(make('<nav>Home Pricing Docs</nav>'))).toBe('navigation');
    expect(classifySection(make('<footer>© 2026</footer>'))).toBe('navigation');
  });

  it('detects a CTA-heavy small section', () => {
    expect(classifySection(make('<section><a>Start free trial</a></section>'))).toBe('cta');
  });

  it('treats a <header> as hero and falls back to generic', () => {
    expect(classifySection(make('<header><h1>Ship faster</h1></header>'))).toBe('hero');
    expect(classifySection(make('<section><p>Some paragraph of prose that carries no strong signal about its role at all whatsoever here.</p></section>'))).toBe('generic');
  });

  it('SEMANTIC_TYPES lists every vocabulary member exactly once', () => {
    expect(new Set(SEMANTIC_TYPES).size).toBe(10);
    expect(SEMANTIC_TYPES).toContain('pricing');
    expect(SEMANTIC_TYPES).toContain('generic');
  });

  it('detects pricing from BODY content alone — div-soup with no ids/headings', () => {
    expect(classifySection(make(
      '<section><div><div>Starter</div><div>$29/mo billed yearly</div><div>Growth $99 per month</div></div></section>',
    ))).toBe('pricing');
  });
});

const f = (over: Partial<SectionFeatures>): SectionFeatures => ({
  tag: 'section', idClass: '', headingText: '', bodyText: '', actionCount: 0, textLength: 300, ...over,
});

describe('classifyFeatures — content-based detection (no ids/classes/headings)', () => {
  it('detects pricing from currency + per-period text alone', () => {
    const r = classifyFeatures(f({ bodyText: 'Starter $29/mo billed yearly. Growth $99 per month. Enterprise: contact us.' }));
    expect(r).toEqual({ type: 'pricing', strength: 'strong' });
  });
  it('detects social proof from star ratings and testimonial quotes', () => {
    const r = classifyFeatures(f({ bodyText: '★★★★★ "This product changed how our team ships every week" — Dana R., CTO. 4.8 out of 5.' }));
    expect(r).toEqual({ type: 'social_proof', strength: 'strong' });
  });
  it('detects trust from guarantee/refund language', () => {
    const r = classifyFeatures(f({ bodyText: '30-day money-back guarantee. Your data is encrypted at rest. Cancel anytime.' }));
    expect(r.type).toBe('trust');
    expect(r.strength).toBe('strong');
  });
  it('detects comparison from vs-language in the body', () => {
    const r = classifyFeatures(f({ bodyText: 'Acme vs. Competitor: see how the plans compare feature by feature.' }));
    expect(r).toEqual({ type: 'comparison', strength: 'strong' });
  });
  it('id/class/heading keywords still win and are strong (legacy behavior)', () => {
    expect(classifyFeatures(f({ idClass: 'pricing-table' }))).toEqual({ type: 'pricing', strength: 'strong' });
  });
  it('structural fallbacks are weak', () => {
    expect(classifyFeatures(f({ actionCount: 2, textLength: 80 }))).toEqual({ type: 'cta', strength: 'weak' });
    expect(classifyFeatures(f({ tag: 'nav' }))).toEqual({ type: 'navigation', strength: 'weak' });
    expect(classifyFeatures(f({}))).toEqual({ type: 'generic', strength: 'weak' });
  });
  it('a plain currency mention in a long article does NOT read as pricing (needs per-period or plan context)', () => {
    const r = classifyFeatures(f({ bodyText: ('The company raised $5 million to expand. ' + 'More words here. '.repeat(30)).trim() }));
    expect(r.type).toBe('generic');
  });
});
