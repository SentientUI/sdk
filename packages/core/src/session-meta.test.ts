import { describe, it, expect } from 'vitest';
import {
  buildSessionUpsertPayload,
  detectDeviceClass,
  deriveSessionSegment,
  detectTimeOfDay,
  detectTrafficSource,
  referrerDomainFromReferer,
  uaTokenMatch,
  matchedAgentToken,
  agentIntent,
  classifiedAgents,
  agentUaList,
  AGENT_INTENTS,
} from './session-meta.js';

describe('uaTokenMatch — known agent user-agent tokens', () => {
  it('matches passive crawler UAs case-insensitively', () => {
    expect(uaTokenMatch('Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)')).toBe(true);
    expect(uaTokenMatch('Mozilla/5.0 (compatible; ClaudeBot/1.0)')).toBe(true);
    expect(uaTokenMatch('Mozilla/5.0 AppleWebKit (compatible; PerplexityBot/1.0)')).toBe(true);
    expect(uaTokenMatch('claudebot')).toBe(true);
  });

  it('matches interactive/user-fetch agent UAs', () => {
    expect(uaTokenMatch('Mozilla/5.0 ... ChatGPT-User/1.0')).toBe(true);
    expect(uaTokenMatch('Mozilla/5.0 ... Claude-User/1.0')).toBe(true);
  });

  it('does not match ordinary human browser UAs', () => {
    expect(
      uaTokenMatch(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ),
    ).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(uaTokenMatch('')).toBe(false);
  });
});

describe('matchedAgentToken', () => {
  it('returns the matched token name for an agent UA', () => {
    expect(matchedAgentToken('Mozilla/5.0 (compatible; GPTBot/1.2)')).toBe('GPTBot');
    expect(matchedAgentToken('something ClaudeBot/1.0 here')).toBe('ClaudeBot');
  });

  it('returns null for a human browser or empty UA', () => {
    expect(matchedAgentToken('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36')).toBeNull();
    expect(matchedAgentToken('')).toBeNull();
  });
});

describe('buildSessionUpsertPayload — automation flag', () => {
  it('is false for a normal human browser with no webdriver', () => {
    const body = buildSessionUpsertPayload('sess-1', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    });
    expect(body.automation).toBe(false);
  });

  it('is true when navigator.webdriver is set', () => {
    const body = buildSessionUpsertPayload('sess-1', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
      webdriver: true,
    });
    expect(body.automation).toBe(true);
  });

  it('is true when the user-agent matches a known agent token', () => {
    const body = buildSessionUpsertPayload('sess-1', {
      userAgent: 'Mozilla/5.0 (compatible; GPTBot/1.2)',
    });
    expect(body.automation).toBe(true);
  });

  it('defaults to false when no signals are present', () => {
    expect(buildSessionUpsertPayload('sess-1').automation).toBe(false);
  });
});

describe('buildSessionUpsertPayload', () => {
  it('defaults to desktop:direct when headers are absent', () => {
    const body = buildSessionUpsertPayload('sess-1');
    expect(body.deviceClass).toBe('desktop');
    expect(body.trafficSource).toBe('direct');
  });

  it('derives segment fields from user-agent and referer', () => {
    const body = buildSessionUpsertPayload('sess-1', {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      referer: 'https://www.google.com/search?q=test',
    });
    expect(body.deviceClass).toBe('desktop');
    expect(body.trafficSource).toBe('search');
  });
});

describe('deriveSessionSegment', () => {
  it('treats same-origin referer as direct', () => {
    expect(
      deriveSessionSegment({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
        referer: 'http://localhost:3001/',
        appOrigin: 'http://localhost:3001',
      }),
    ).toBe('desktop:direct');
  });
});

describe('detectDeviceClass', () => {
  it('detects mobile', () => {
    expect(detectDeviceClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('mobile');
  });
});

describe('detectTimeOfDay — exact hour boundaries', () => {
  // Buckets: h<6 night, h<12 morning, h<18 afternoon, else evening.
  // Use local-time constructor so getHours() is deterministic regardless of TZ.
  const atHour = (h: number) => new Date(2026, 0, 1, h, 0, 0);

  it('hour 0 is night', () => expect(detectTimeOfDay(atHour(0))).toBe('night'));
  it('hour 5 is night (last night hour)', () => expect(detectTimeOfDay(atHour(5))).toBe('night'));
  it('hour 6 is morning (boundary)', () => expect(detectTimeOfDay(atHour(6))).toBe('morning'));
  it('hour 11 is morning (last morning hour)', () => expect(detectTimeOfDay(atHour(11))).toBe('morning'));
  it('hour 12 is afternoon (boundary)', () => expect(detectTimeOfDay(atHour(12))).toBe('afternoon'));
  it('hour 17 is afternoon (last afternoon hour)', () => expect(detectTimeOfDay(atHour(17))).toBe('afternoon'));
  it('hour 18 is evening (boundary)', () => expect(detectTimeOfDay(atHour(18))).toBe('evening'));
  it('hour 23 is evening', () => expect(detectTimeOfDay(atHour(23))).toBe('evening'));
});

describe('detectTrafficSource — malformed / invalid referrer URLs', () => {
  it('empty referrer → direct', () => {
    expect(detectTrafficSource('')).toBe('direct');
  });

  it('non-URL garbage → direct (URL constructor throws, caught)', () => {
    expect(detectTrafficSource('not a url at all')).toBe('direct');
  });

  it('protocol-relative string without scheme → direct', () => {
    // '//example.com/foo' is not an absolute URL → new URL throws → direct.
    expect(detectTrafficSource('//example.com/foo')).toBe('direct');
  });

  it('valid search engine host → search', () => {
    expect(detectTrafficSource('https://www.google.com/search?q=x')).toBe('search');
    expect(detectTrafficSource('https://duckduckgo.com/?q=x')).toBe('search');
  });

  it('valid social host → social', () => {
    expect(detectTrafficSource('https://t.co/abc')).toBe('social');
    expect(detectTrafficSource('https://www.linkedin.com/feed')).toBe('social');
    expect(detectTrafficSource('https://twitter.com/x')).toBe('social');
    expect(detectTrafficSource('https://x.com/x')).toBe('social');
    expect(detectTrafficSource('https://www.facebook.com/x')).toBe('social');
    expect(detectTrafficSource('https://old.reddit.com/r/x')).toBe('social');
  });

  it('look-alike hosts are not misclassified as social', () => {
    // Substring matches without a right boundary previously flagged these.
    expect(detectTrafficSource('https://x.company.com/page')).toBe('referral');
    expect(detectTrafficSource('https://t.company.io/page')).toBe('referral');
    expect(detectTrafficSource('https://linkedinsights.com/page')).toBe('referral');
    expect(detectTrafficSource('https://twitternews.example.com/page')).toBe('referral');
  });

  it('unknown external host → referral', () => {
    expect(detectTrafficSource('https://news.example.org/article')).toBe('referral');
  });

  it('same-host appOrigin → direct', () => {
    expect(
      detectTrafficSource('https://app.example.com/path', 'https://app.example.com'),
    ).toBe('direct');
  });

  it('invalid appOrigin is ignored, classification proceeds on referrer', () => {
    // appOrigin 'garbage' throws inside the inner try (caught), so it does not
    // short-circuit to direct; google referrer still classifies as search.
    expect(detectTrafficSource('https://www.google.com/', 'garbage')).toBe('search');
  });
});

describe('referrerDomainFromReferer', () => {
  it('returns hostname for a valid URL', () => {
    expect(referrerDomainFromReferer('https://www.example.com/a/b')).toBe('www.example.com');
  });
  it('returns null for empty input', () => {
    expect(referrerDomainFromReferer('')).toBeNull();
  });
  it('returns null for a malformed URL', () => {
    expect(referrerDomainFromReferer('::::not-a-url')).toBeNull();
  });
});

describe('agentIntent', () => {
  it('classifies the published provider UAs', () => {
    expect(agentIntent('ChatGPT-User')).toBe('user');
    expect(agentIntent('Claude-User')).toBe('user');
    expect(agentIntent('Perplexity-User')).toBe('user');
    expect(agentIntent('OAI-SearchBot')).toBe('search');
    expect(agentIntent('Claude-SearchBot')).toBe('search');
    expect(agentIntent('PerplexityBot')).toBe('search');
    expect(agentIntent('GPTBot')).toBe('training');
    expect(agentIntent('ClaudeBot')).toBe('training');
    expect(agentIntent('CCBot')).toBe('training');
    expect(agentIntent('Amazonbot')).toBe('other');
    expect(agentIntent('Diffbot')).toBe('other');
  });
  it('is case-insensitive and defaults unknown/null to other', () => {
    expect(agentIntent('gptbot')).toBe('training');
    expect(agentIntent('unclassified agent')).toBe('other');
    expect(agentIntent(null)).toBe('other');
  });
  it('every agentUaList token has an explicit mapping', () => {
    for (const t of agentUaList) expect(AGENT_INTENTS[t]).toBeDefined();
  });
  it('classifiedAgents groups every token exactly once', () => {
    const g = classifiedAgents();
    const flat = [...g.user, ...g.search, ...g.training, ...g.other];
    expect(flat.slice().sort()).toEqual(agentUaList.slice().sort());
  });
});
