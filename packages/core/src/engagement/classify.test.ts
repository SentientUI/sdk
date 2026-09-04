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
    expect(classifyFeatures(f({}))).toEqual({ type: 'generic', strength: 'weak' });
  });

  it('a <nav> tag is STRONG, not a fallback (Phase 2b)', () => {
    // Changed deliberately. A <nav> tag is a structural fact, not a guess, and
    // section-classify.ts only stores `strong` results — so while this was
    // `weak`, navigation sections were classified and then thrown away. Phase 2c
    // needs role='structural' on record to pin them out of the reorderable set.
    expect(classifyFeatures(f({ tag: 'nav' }))).toEqual({ type: 'navigation', strength: 'strong' });
  });
  it('a plain currency mention in a long article does NOT read as pricing (needs per-period or plan context)', () => {
    const r = classifyFeatures(f({ bodyText: ('The company raised $5 million to expand. ' + 'More words here. '.repeat(30)).trim() }));
    expect(r.type).toBe('generic');
  });
});

// ---------------------------------------------------------------------------
// Phase 2b — topic-aware classifier.
// ---------------------------------------------------------------------------
import { classifyTopic } from './topics';

const tf = (o: Partial<SectionFeatures>): SectionFeatures => ({
  tag: 'section', idClass: '', headingText: '', bodyText: '', actionCount: 0, textLength: 300, ...o,
});

describe('classifyTopic — reproduced misclassifications', () => {
  it('classifies a div navbar as structural, not cta', () => {
    // Reproduced against the shipped classifier: `navigation` was reachable only
    // via tag nav/footer, so <div class="navbar"> with links and short text fell
    // through to the cta rule.
    const r = classifyTopic(tf({ tag: 'div', idClass: 'navbar', bodyText: 'Home Services Contact', actionCount: 8, textLength: 60 }));
    expect(r.role).toBe('structural');
    expect(r.parent).toBe('navigation');
  });

  it('classifies a <header> containing a button as hero, not cta', () => {
    // The cta rule sat ABOVE both hero rules, so any header with an action and
    // under 200 chars could never be a hero.
    const r = classifyTopic(tf({ tag: 'header', idClass: 'hero', headingText: 'Expert Car Repair', bodyText: 'Expert Car Repair. Book now.', actionCount: 1, textLength: 120 }));
    expect(r.parent).toBe('hero');
  });

  it('does not call "Our Plans for Your Repair" pricing', () => {
    // /\bplans?\b/ fired on any heading containing "plans" and, being `strong`,
    // auto-applied at confidence 0.9 and was never LLM-checked.
    const r = classifyTopic(tf({ headingText: 'Our Plans for Your Repair', bodyText: 'We plan your repair carefully.' }));
    expect(r.parent).not.toBe('pricing');
  });

  it('does not call a "Customer Service" footer link block social proof', () => {
    // /\bcustomers?\b/ was broad enough to fire on navigation furniture.
    const r = classifyTopic(tf({ tag: 'div', idClass: 'footer-links', headingText: 'Customer Service', bodyText: 'Contact us', actionCount: 5, textLength: 90 }));
    expect(r.parent).not.toBe('social_proof');
  });

  it('still calls a real pricing section pricing', () => {
    const r = classifyTopic(tf({ headingText: 'Pricing', bodyText: 'Starter $19/mo. Pro $49/mo.' }));
    expect(r.parent).toBe('pricing');
  });
});

describe('classifyTopic — non-SaaS vocabulary', () => {
  const cases: Array<[string, string, string]> = [
    ['Our Services', 'services', 'features'],
    ['Our Process', 'process', 'features'],
    ['Why Choose Us', 'about', 'trust'],
    ['Insurance Approved Repairs', 'insurance', 'trust'],
    ['Gallery', 'gallery', 'social_proof'],
    ['Brands We Work With', 'brands', 'social_proof'],
    ['Our Team', 'team', 'trust'],
    ['Our Menu', 'menu', 'features'],
    ['Opening Hours', 'hours', 'cta'],
    ['Book a table', 'booking', 'cta'],
  ];
  for (const [heading, topic, parent] of cases) {
    it(`classifies "${heading}" as ${topic}/${parent}`, () => {
      const r = classifyTopic(tf({ headingText: heading, bodyText: heading }));
      expect(r.topic).toBe(topic);
      expect(r.parent).toBe(parent);
    });
  }
});

describe('classifyTopic — ARIA landmarks', () => {
  it('treats role=banner as hero', () => {
    expect(classifyTopic(tf({ tag: 'div', ariaRole: 'banner' })).parent).toBe('hero');
  });
  it('treats role=contentinfo as structural', () => {
    expect(classifyTopic(tf({ tag: 'div', ariaRole: 'contentinfo' })).role).toBe('structural');
  });
});

describe('classifyTopic — structured data (stage 0)', () => {
  it('lets an Offer beat an ambiguous heading', () => {
    const r = classifyTopic(tf({ headingText: 'What it costs you', structuredTypes: ['Offer'] }));
    expect(r.topic).toBe('pricing_plans');
    expect(r.parent).toBe('pricing');
  });

  it('classifies FAQPage as faq even with no matching prose', () => {
    const r = classifyTopic(tf({ headingText: 'Things people ask', structuredTypes: ['FAQPage'] }));
    expect(r.parent).toBe('faq');
  });

  it('classifies AggregateRating as reviews', () => {
    const r = classifyTopic(tf({ headingText: 'Word on the street', structuredTypes: ['AggregateRating'] }));
    expect(r.parent).toBe('social_proof');
  });

  it('does NOT let a site-wide Organization blob override a <nav>', () => {
    // Many sites emit Organization JSON-LD in the header or footer. Structural
    // facts must outrank it, or every such nav becomes an `about` section.
    const r = classifyTopic(tf({ tag: 'nav', structuredTypes: ['Organization'] }));
    expect(r.parent).toBe('navigation');
    expect(r.role).toBe('structural');
  });

  it('ignores an unmapped schema type and falls through to keywords', () => {
    const r = classifyTopic(tf({ headingText: 'Our Services', structuredTypes: ['WebPage'] }));
    expect(r.topic).toBe('services');
  });
});
