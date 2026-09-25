import { describe, expect, it, vi } from 'vitest';
import { describeResult, fetchLiftSummary, type LiftSummary } from './results.server';

const base: LiftSummary = {
  projectId: 'p1',
  goal: { name: 'Purchase' },
  evidence: 'collecting',
  liftPct: null,
  samples: { personalized: { visitors: 40, conversions: 1 }, control: { visitors: 5, conversions: 0 }, minPerArm: 100 },
  computedAt: '2026-09-25T10:00:00Z',
};

describe('describeResult (audit H12)', () => {
  it('never calls anything a win unless the test says so', () => {
    expect(describeResult({ ...base, evidence: 'not_significant', liftPct: 12.3 }).headline).toBe('No clear difference yet');
    expect(describeResult({ ...base, evidence: 'not_significant', liftPct: 12.3 }).tone).toBe('info');
    expect(describeResult({ ...base, evidence: 'significant_positive', liftPct: 12.3 })).toMatchObject({ tone: 'success', headline: 'Converting about 12% better than your original' });
  });
  it('a significantly worse result reads as worse, with a prompt to act', () => {
    const r = describeResult({ ...base, evidence: 'significant_negative', liftPct: -4.2 });
    expect(r).toMatchObject({ tone: 'warning', headline: 'Converting about 4.2% worse than your original' });
    expect(r.detail).toMatch(/Review/);
  });
  it('while collecting it shows counts and the floor, no rates', () => {
    const r = describeResult(base);
    expect(r.detail).toContain('40 visitors');
    expect(r.detail).toContain('100 visitors');
    expect(r.detail).not.toMatch(/%/);
  });
});

describe('fetchLiftSummary', () => {
  it('uses the sk_ and returns null on any failure', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => base }));
    expect(await fetchLiftSummary('sk_x', f as unknown as typeof fetch)).toEqual(base);
    expect(((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).authorization).toBe('Bearer sk_x');
    expect(await fetchLiftSummary('sk_x', vi.fn(async () => ({ ok: false })) as unknown as typeof fetch)).toBeNull();
    expect(await fetchLiftSummary('sk_x', vi.fn(async () => { throw new Error('x'); }) as unknown as typeof fetch)).toBeNull();
  });
});

describe('describeResult caveats Home shows (review R2 N5/M3)', () => {
  it('a failed group-size check puts even a significant result on hold', () => {
    const r = describeResult({ ...base, evidence: 'significant_positive', liftPct: 12, splitCheck: { state: 'mismatch' } });
    expect(r).toMatchObject({ tone: 'warning', headline: 'Result on hold' });
  });
  it('shadow mode states the pause — nothing is measured now, and no verdict is given (review R3)', () => {
    const r = describeResult({ ...base, evidence: 'significant_positive', liftPct: 12, shadowMode: true });
    expect(r).toMatchObject({ tone: 'info', headline: 'Paused (shadow mode)' });
    expect(r.detail).toMatch(/no new results/);
    expect(r.detail).not.toMatch(/would/i);
  });
  it('shows the range in points alongside the point estimate', () => {
    const r = describeResult({ ...base, evidence: 'significant_positive', liftPct: 0.04, diffInterval: { lower: 0.0001, upper: 0.0021 } });
    expect(r.detail).toContain('+0.0 to +0.2 points');
  });
});

