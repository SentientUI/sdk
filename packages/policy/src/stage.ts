/**
 * Funnel stage and visit context (docs/buying-stage-retargeting-2026-10-09.md).
 *
 * STAGE — where the visitor is in buying, from their own history on this site
 * strictly BEFORE the decision. Never sent by the client, never declared.
 * CONTEXT — the one learning axis: a strong-intent ARRIVAL CLASS for this visit
 * when there is one, otherwise the stage.
 *
 * Pure. The caller supplies history read from the visitor row and the visit's
 * arrival; nothing here reads a clock it was not given.
 */

export const STAGE_KEYS = ['new', 'browsing', 'carted', 'customer', 'lapsed'] as const;
export type Stage = (typeof STAGE_KEYS)[number];

export const ARRIVAL_CLASSES = [
  'cart_recovery',
  'offer',
  'product_ad',
  'search_intent',
  'retargeting',
  'referred',
  'paid_prospecting',
] as const;
export type ArrivalClass = (typeof ARRIVAL_CLASSES)[number];

/** Merchant-confirmed tags for a campaign (projects.settings.campaignIntents). */
export const CAMPAIGN_INTENTS = ['cart_recovery', 'retargeting', 'win_back', 'offer', 'new_arrivals', 'gift'] as const;
export type CampaignIntent = (typeof CAMPAIGN_INTENTS)[number];

export type StageHistory = {
  /** The visitor has a closed earlier visit (sessions.closed_at set before this decision). */
  returning: boolean;
  purchaseCount: number;
  lastPurchaseAt: Date | null;
  lastCartAt: Date | null;
};

export type StageWindows = { cartWindowDays: number; lapseWindowDays: number };

export type StageResult = { stage: Stage; source: 'observed' | 'hinted' };

const DAY_MS = 86_400_000;

/**
 * One stage per visitor. Precedence: a live cart (added since the last
 * purchase, inside the cart window) beats everything — the visitor in front of
 * us stopped short of buying, whatever they bought before; then customer or
 * lapsed by the last purchase's age; then browsing for a returning visitor;
 * else new.
 *
 * A `hint` (from a mapped cart-recovery, retargeting or win-back click) only
 * ever RAISES a visitor with no buying history — `new` or `browsing` — and is
 * reported as `hinted`. History always wins: a customer who clicks a
 * cart-recovery email stays a customer. This is what recovers a retargeted
 * Safari visitor whose cookie (and so whose history) has expired.
 */
export function computeStage(
  history: StageHistory,
  windows: StageWindows,
  now: Date,
  hint: Stage | null = null,
): StageResult {
  const t = now.getTime();
  const purchaseAt = history.lastPurchaseAt?.getTime() ?? null;
  const cartAt = history.lastCartAt?.getTime() ?? null;

  const cartLive =
    cartAt !== null &&
    t - cartAt <= windows.cartWindowDays * DAY_MS &&
    (purchaseAt === null || cartAt > purchaseAt);
  if (cartLive) return { stage: 'carted', source: 'observed' };

  if (history.purchaseCount > 0 && purchaseAt !== null) {
    return { stage: t - purchaseAt <= windows.lapseWindowDays * DAY_MS ? 'customer' : 'lapsed', source: 'observed' };
  }

  const observed: Stage = history.returning ? 'browsing' : 'new';
  if (hint && hint !== 'new' && !(hint === 'browsing' && observed === 'browsing')) {
    return { stage: hint, source: 'hinted' };
  }
  return { stage: observed, source: 'observed' };
}

/** What a merchant-confirmed campaign tag says about the visitor's stage, if anything. */
export function stageHintFor(intent: CampaignIntent | null): Stage | null {
  switch (intent) {
    case 'cart_recovery': return 'carted';
    case 'retargeting': return 'browsing';
    case 'win_back': return 'lapsed';
    default: return null;
  }
}

export type ArrivalFacts = {
  channel: string | null;
  paid: boolean;
  landingPath: string | null;
  campaignIntent: CampaignIntent | null;
  /** utm_term present (a paid-search keyword). The keyword itself is never needed here. */
  hasSearchTerm: boolean;
};

const PRODUCT_PATH = /\/products\/[^/]+/;
const DISCOUNT_PATH = /^\/discount\/[^/]+/;

/**
 * The strong-intent class of this visit's arrival, or null. Precedence follows
 * the design note's table, top to bottom: the most specific promise the click
 * made wins (a cart-recovery email that lands on a product page is still cart
 * recovery).
 */
export function arrivalClass(a: ArrivalFacts): ArrivalClass | null {
  if (a.campaignIntent === 'cart_recovery') return 'cart_recovery';
  if ((a.landingPath && DISCOUNT_PATH.test(a.landingPath)) || a.campaignIntent === 'offer') return 'offer';
  if (a.paid && a.landingPath && PRODUCT_PATH.test(a.landingPath)) return 'product_ad';
  if (a.channel === 'paid_search' && a.hasSearchTerm) return 'search_intent';
  if (a.campaignIntent === 'retargeting') return 'retargeting';
  if (a.channel === 'video' || a.channel === 'affiliate' || a.channel === 'ai_assistant') return 'referred';
  if (a.channel === 'paid_social') return 'paid_prospecting';
  return null;
}

/** The visit's single learning-axis value: the arrival class when there is one, else the stage. */
export function resolveContext(stage: Stage, cls: ArrivalClass | null): Stage | ArrivalClass {
  return cls ?? stage;
}

/** Normalizes a stored campaign → tag map entry; unknown tags are ignored. */
export function campaignIntentOf(
  map: Record<string, unknown> | null | undefined,
  utmCampaign: string | null | undefined,
): CampaignIntent | null {
  if (!map || !utmCampaign) return null;
  const tag = map[utmCampaign.trim().toLowerCase()];
  return typeof tag === 'string' && (CAMPAIGN_INTENTS as readonly string[]).includes(tag) ? (tag as CampaignIntent) : null;
}
