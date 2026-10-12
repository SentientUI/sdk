/**
 * How a visitor arrived, from first-party landing-request facts only
 * (docs/buying-stage-retargeting-2026-10-09.md, "Arrival signals").
 *
 * Inputs are what the landing request already carries: UTM params, WHICH
 * ad-platform click-ID keys are present (never their values), the referrer
 * host, the user agent (in-app browsers often send no referrer at all) and the
 * site's own host. Never ad-platform cookies (_fbp, _ga, _ttp, …), never a
 * pixel payload, nothing cross-site.
 *
 * Precedence: explicit UTM > click-ID presence > referrer host > in-app user
 * agent > direct. `attributed: false` means nothing on the request says where
 * the visitor came from (direct, or an internal navigation) — callers must not
 * let such a request overwrite an earlier visit's arrival.
 *
 * The channel set is bounded on purpose: it is meant to become a learning
 * dimension (plan, Phase 6b), so it must never grow with the long tail of
 * referrers. `platform` is for reporting and campaign mapping only.
 */

export type ArrivalChannel =
  | 'paid_search'
  | 'organic_search'
  | 'paid_social'
  | 'organic_social'
  | 'video'
  | 'email_sms'
  | 'affiliate'
  | 'ai_assistant'
  | 'marketplace_app'
  | 'referral'
  | 'direct';

export type Arrival = {
  channel: ArrivalChannel;
  /** Normalized platform name ('google', 'meta', 'tiktok', 'klaviyo', …), or null. */
  platform: string | null;
  /** True only on positive evidence of a paid click (a paid utm_medium, or a click ID other than fbclid). */
  paid: boolean;
  attributed: boolean;
};

export type ArrivalInput = {
  utmParams?: Record<string, string> | null;
  /** Click-ID KEYS present on the landing URL (gclid, fbclid, …). Values are never needed. */
  clickIdKeys?: readonly string[] | null;
  referrerHost?: string | null;
  /** The site's own host, so an internal navigation is not read as a referral. */
  siteHost?: string | null;
  userAgent?: string | null;
};

type Kind = 'search' | 'social' | 'video' | 'ai' | 'app' | 'webmail';

// Ordered: more specific hosts first (gemini.google.com before google.*,
// mail.google.com before google.*). Matched against the host and its parents.
const HOSTS: ReadonlyArray<readonly [RegExp, string, Kind]> = [
  [/(^|\.)gemini\.google\.com$/, 'gemini', 'ai'],
  [/(^|\.)mail\.google\.com$/, 'gmail', 'webmail'],
  [/(^|\.)(chatgpt\.com|chat\.openai\.com)$/, 'chatgpt', 'ai'],
  [/(^|\.)perplexity\.ai$/, 'perplexity', 'ai'],
  [/(^|\.)claude\.ai$/, 'claude', 'ai'],
  [/(^|\.)copilot\.microsoft\.com$/, 'copilot', 'ai'],
  [/(^|\.)(outlook\.live\.com|outlook\.office\.com|mail\.yahoo\.com)$/, 'webmail', 'webmail'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube', 'video'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com|instagram\.com|threads\.net)$/, 'meta', 'social'],
  [/(^|\.)tiktok\.com$/, 'tiktok', 'social'],
  [/(^|\.)(pinterest\.[a-z.]+|pin\.it)$/, 'pinterest', 'social'],
  [/(^|\.)(x\.com|twitter\.com|t\.co)$/, 'x', 'social'],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, 'linkedin', 'social'],
  [/(^|\.)reddit\.com$/, 'reddit', 'social'],
  [/(^|\.)snapchat\.com$/, 'snapchat', 'social'],
  [/(^|\.)shop\.app$/, 'shop_app', 'app'],
  [/(^|\.)google\.[a-z.]+$/, 'google', 'search'],
  [/(^|\.)bing\.com$/, 'microsoft', 'search'],
  [/(^|\.)duckduckgo\.com$/, 'duckduckgo', 'search'],
  [/(^|\.)(search\.)?yahoo\.[a-z.]+$/, 'yahoo', 'search'],
  [/(^|\.)(ecosia\.org|baidu\.com|yandex\.[a-z.]+|search\.brave\.com)$/, 'search', 'search'],
];

// utm_source values that name a platform outright.
const SOURCES: Readonly<Record<string, readonly [string, Kind | 'email' | 'sms']>> = {
  google: ['google', 'search'], adwords: ['google', 'search'], bing: ['microsoft', 'search'],
  microsoft: ['microsoft', 'search'], youtube: ['youtube', 'video'],
  facebook: ['meta', 'social'], fb: ['meta', 'social'], instagram: ['meta', 'social'],
  ig: ['meta', 'social'], meta: ['meta', 'social'], threads: ['meta', 'social'],
  tiktok: ['tiktok', 'social'], pinterest: ['pinterest', 'social'], twitter: ['x', 'social'],
  x: ['x', 'social'], linkedin: ['linkedin', 'social'], reddit: ['reddit', 'social'],
  snapchat: ['snapchat', 'social'], chatgpt: ['chatgpt', 'ai'], 'chatgpt.com': ['chatgpt', 'ai'],
  perplexity: ['perplexity', 'ai'], shop_app: ['shop_app', 'app'], shop: ['shop_app', 'app'],
  klaviyo: ['klaviyo', 'email'], shopify_email: ['shopify_email', 'email'], mailchimp: ['mailchimp', 'email'],
  omnisend: ['omnisend', 'email'], newsletter: ['newsletter', 'email'], email: ['email', 'email'],
  attentive: ['attentive', 'sms'], postscript: ['postscript', 'sms'], sms: ['sms', 'sms'],
};

const PAID_MEDIA = /^(cpc|ppc|paid|paid[-_ ]?search|sem|paid[-_ ]?social|social[-_ ]?paid|paidsocial|cpm|cpv|display|banner|retargeting|remarketing|shopping|pmax)$/;
const SOCIAL_MEDIA = /^(social|social[-_ ]?media|sm|organic[-_ ]?social|social[-_ ]?network)$/;
const EMAIL_MEDIA = /^(e-?mail|newsletter|sms|text|push)$/;
const AFFILIATE_MEDIA = /^(affiliate|affiliates|partner|partners|partnership|influencer|creator|collab|collabs|referral[-_ ]?program)$/;

// In-app browsers. Checked only when nothing else is on the request.
const IN_APP: ReadonlyArray<readonly [RegExp, string]> = [
  [/Instagram/, 'meta'],
  [/FBAN|FBAV|FB_IAB|FBIOS/, 'meta'],
  [/musical_ly|BytedanceWebview|TikTok/i, 'tiktok'],
  [/Pinterest/, 'pinterest'],
  [/Snapchat/, 'snapchat'],
  [/LinkedInApp/, 'linkedin'],
];

function hostKind(host: string): { platform: string; kind: Kind } | null {
  for (const [re, platform, kind] of HOSTS) {
    if (re.test(host)) return { platform, kind };
  }
  return null;
}

function isInternal(host: string, siteHost: string | null | undefined): boolean {
  if (!siteHost) return false;
  const strip = (h: string): string => h.toLowerCase().replace(/^www\./, '');
  const a = strip(host);
  const b = strip(siteHost);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

const kindChannel = (kind: Kind, paid: boolean): ArrivalChannel => {
  switch (kind) {
    case 'search': return paid ? 'paid_search' : 'organic_search';
    case 'social': return paid ? 'paid_social' : 'organic_social';
    case 'video': return 'video';
    case 'ai': return 'ai_assistant';
    case 'app': return 'marketplace_app';
    case 'webmail': return 'email_sms';
  }
};

export function classifyArrival(input: ArrivalInput): Arrival {
  const utm = Object.fromEntries(
    Object.entries(input.utmParams ?? {}).map(([k, v]) => [k.toLowerCase(), String(v).trim().toLowerCase()]),
  );
  const clicks = new Set((input.clickIdKeys ?? []).map((k) => k.toLowerCase()));
  const refHost = input.referrerHost?.toLowerCase().trim() || null;
  const external = refHost && !isInternal(refHost, input.siteHost) ? refHost : null;
  const refKind = external ? hostKind(external) : null;

  // A click ID other than fbclid is proof of a paid click; fbclid is appended
  // to organic Meta clicks too, so it names the platform but not the spend.
  const paidClick = [...clicks].some((k) => k !== 'fbclid');

  // 1. Explicit UTMs.
  const source = utm['utm_source'] ?? '';
  const medium = utm['utm_medium'] ?? '';
  if (source || medium) {
    const known = SOURCES[source] ?? null;
    const platform = known?.[0] ?? (source || refKind?.platform || null);
    const kind = known?.[1] ?? refKind?.kind ?? null;
    const paid = PAID_MEDIA.test(medium) || paidClick;
    let channel: ArrivalChannel;
    if (AFFILIATE_MEDIA.test(medium)) channel = 'affiliate';
    else if (EMAIL_MEDIA.test(medium) || kind === 'email' || kind === 'sms') channel = 'email_sms';
    else if (medium === 'video' || kind === 'video') channel = 'video';
    else if (kind === 'ai') channel = 'ai_assistant';
    else if (kind === 'app') channel = 'marketplace_app';
    else if (kind === 'social' || SOCIAL_MEDIA.test(medium)) channel = paid ? 'paid_social' : 'organic_social';
    else if (kind === 'search' || medium === 'organic') channel = paid ? 'paid_search' : 'organic_search';
    // A paid medium from an unknown source (a display network, a niche ad
    // platform): paid traffic, but not search and not social.
    else channel = 'referral';
    return { channel, platform, paid, attributed: true };
  }

  // 2. Click IDs without UTMs (auto-tagging only).
  if (clicks.size > 0) {
    if (clicks.has('gclid') || clicks.has('gbraid') || clicks.has('wbraid')) {
      // Google Ads covers YouTube too; the referrer is the only tell.
      return refKind?.platform === 'youtube'
        ? { channel: 'video', platform: 'youtube', paid: true, attributed: true }
        : { channel: 'paid_search', platform: 'google', paid: true, attributed: true };
    }
    if (clicks.has('msclkid')) return { channel: 'paid_search', platform: 'microsoft', paid: true, attributed: true };
    if (clicks.has('ttclid')) return { channel: 'paid_social', platform: 'tiktok', paid: true, attributed: true };
    if (clicks.has('twclid')) return { channel: 'paid_social', platform: 'x', paid: true, attributed: true };
    if (clicks.has('li_fat_id')) return { channel: 'paid_social', platform: 'linkedin', paid: true, attributed: true };
    if (clicks.has('fbclid')) return { channel: 'organic_social', platform: 'meta', paid: false, attributed: true };
  }

  // 3. Referrer host.
  if (external) {
    return refKind
      ? { channel: kindChannel(refKind.kind, false), platform: refKind.platform, paid: false, attributed: true }
      : { channel: 'referral', platform: external.replace(/^www\./, ''), paid: false, attributed: true };
  }

  // 4. In-app browser with no referrer.
  const ua = input.userAgent ?? '';
  if (!refHost && ua) {
    for (const [re, platform] of IN_APP) {
      if (re.test(ua)) return { channel: 'organic_social', platform, paid: false, attributed: true };
    }
  }

  return { channel: 'direct', platform: null, paid: false, attributed: false };
}

/** The path of a landing URL or path, without query or fragment, capped — never the query string, which can carry tokens. */
export function normalizeLandingPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let path = raw;
  try {
    if (/^https?:\/\//i.test(raw)) path = new URL(raw).pathname;
  } catch {
    return null;
  }
  path = path.split(/[?#]/)[0] ?? '';
  if (!path.startsWith('/')) return null;
  return path.slice(0, 256);
}
