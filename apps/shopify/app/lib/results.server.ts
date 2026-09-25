// The Results card in the embedded admin (audit H12). Numbers come from the
// SentientUI API's lift snapshot — the same one the dashboard Home card and a
// shared report show — and are put into words here, honestly: nothing is
// called a win unless the always-valid test says so, and below the display
// floor only visitor counts are shown.
import { sentientApiUrl } from './settings.server';

export type LiftSummary = {
  projectId: string;
  goal: { name: string };
  evidence: 'collecting' | 'awaiting_conversions' | 'not_significant' | 'significant_positive' | 'significant_negative';
  liftPct: number | null;
  samples: {
    personalized: { visitors: number; conversions: number };
    control: { visitors: number; conversions: number };
    minPerArm: number;
  };
  computedAt: string;
  /** Always-valid range on the absolute conversion-rate difference. */
  diffInterval?: { lower: number; upper: number } | null;
  /** Failed group-size check: the split is broken, so no result stands. */
  splitCheck?: { state: string } | null;
  /** Shadow mode: nothing is served or measured now; any numbers are from
   *  before it was switched on. */
  shadowMode?: boolean;
};

export async function fetchLiftSummary(secretKey: string, fetchImpl: typeof fetch = fetch): Promise<LiftSummary | null> {
  try {
    const res = await fetchImpl(`${sentientApiUrl()}/v1/provision/shopify/summary`, {
      headers: { authorization: `Bearer ${secretKey}` },
      // The admin page waits on this; a slow API must not hold it.
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<LiftSummary>;
    return body && typeof body.evidence === 'string' && body.samples ? (body as LiftSummary) : null;
  } catch {
    return null;
  }
}

export type ResultText = { tone: 'success' | 'warning' | 'info'; headline: string; detail: string };

const n = (v: number) => v.toLocaleString('en-US');
const pct = (v: number) => `${Math.abs(v) >= 10 ? Math.round(Math.abs(v)) : Math.abs(v).toFixed(1)}%`;

const pts = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}`;

export function describeResult(s: LiftSummary): ResultText {
  const p = s.samples.personalized;
  const c = s.samples.control;
  // Shadow mode serves nothing and measures nothing (no exposures are written
  // under it), so there is no current result to state — and the numbers held
  // are from before it was switched on, not a would-have-been (review R3).
  if (s.shadowMode) {
    return {
      tone: 'info',
      headline: 'Paused (shadow mode)',
      detail: `SentientUI is not serving adapted versions right now, so no new results are being measured. Turn shadow mode off in SentientUI to start. So far: ${n(p.visitors)} visitors saw the adapted versions and ${n(c.visitors)} saw your original, before the pause.`,
    };
  }
  const counts = `${n(p.visitors)} visitors saw the adapted versions and ${n(c.visitors)} saw your original, measured on ${s.goal.name}.`;
  // Home shows "should not be trusted" above a result whose group sizes are
  // off; the card announced a win over it (review R2 M3).
  if (s.splitCheck?.state === 'mismatch' && s.evidence !== 'collecting') {
    return {
      tone: 'warning',
      headline: 'Result on hold',
      detail: `${counts} The control group is not the size it should be, so this result can't be trusted yet. Check the install in SentientUI.`,
    };
  }
  // The range, not just the point: a tiny significant lift read "0.0% better".
  const range = s.diffInterval ? ` Conversion rate ${pts(s.diffInterval.lower)} to ${pts(s.diffInterval.upper)} points versus your original.` : '';
  switch (s.evidence) {
    case 'collecting':
      return {
        tone: 'info',
        headline: 'Collecting visits',
        detail: `${counts} A lift number appears once each group has ${n(s.samples.minPerArm)} visitors.`,
      };
    case 'awaiting_conversions':
      return { tone: 'info', headline: 'Waiting for conversions', detail: `${counts} There are not enough conversions yet to compare the groups.` };
    case 'not_significant':
      return {
        tone: 'info',
        headline: 'No clear difference yet',
        detail: `${counts}${s.liftPct !== null ? ` The groups differ by ${s.liftPct >= 0 ? '+' : '−'}${pct(s.liftPct)} so far, which is still within chance.` : ''}`,
      };
    case 'significant_positive':
      return {
        tone: 'success',
        headline: s.liftPct !== null
          ? `Converting about ${pct(s.liftPct)} better than your original`
          : `Converting better than your original`,
        detail: `${counts}${range}`,
      };
    case 'significant_negative':
      return {
        tone: 'warning',
        headline: s.liftPct !== null
          ? `Converting about ${pct(s.liftPct)} worse than your original`
          : `Converting worse than your original`,
        detail: `${counts}${range} Review the versions in SentientUI.`,
      };
  }
}
