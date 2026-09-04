import { describe, expect, it } from 'vitest';
import {
  DROP_BANNER_WINDOW_MS,
  FORWARD_RECORD_INTERVAL_MS,
  isDropBannerVisible,
  isStaleUninstall,
  shouldRecordForward,
} from './drop-visibility';

const NOW = new Date('2026-09-02T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() - n * 60_000);
const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60_000);

describe('shouldRecordForward — the cheap-write guard', () => {
  it('writes when nothing was ever recorded', () => {
    expect(shouldRecordForward(NOW, null, null)).toBe(true);
  });

  it('skips the write while the stored timestamp is under an hour old', () => {
    // A busy shop must not pay a DB write per successful webhook.
    expect(shouldRecordForward(NOW, minutes(59), null)).toBe(false);
  });

  it('writes once the stored timestamp is an hour old', () => {
    expect(shouldRecordForward(NOW, new Date(NOW.getTime() - FORWARD_RECORD_INTERVAL_MS), null)).toBe(true);
  });

  it('writes despite a fresh timestamp when a drop was recorded after it', () => {
    // Otherwise a drop followed by a recovered forward within the hour left
    // lastForwardAt older than lastDropAt — banner stuck for up to an hour
    // after the merchant already fixed the key.
    expect(shouldRecordForward(NOW, minutes(30), minutes(10))).toBe(true);
  });

  it('does not let an OLD drop force writes forever', () => {
    expect(shouldRecordForward(NOW, minutes(30), minutes(45))).toBe(false);
  });
});

describe('isDropBannerVisible — merchant-facing drop warning', () => {
  it('hidden when no drop was ever recorded', () => {
    expect(isDropBannerVisible(NOW, null, null)).toBe(false);
  });

  it('shown for a recent drop with no forward since', () => {
    expect(isDropBannerVisible(NOW, days(1), null)).toBe(true);
    expect(isDropBannerVisible(NOW, days(1), days(2))).toBe(true);
  });

  it('clears naturally once a forward succeeds after the drop', () => {
    // The all-clear is orders flowing again — no manual dismissal.
    expect(isDropBannerVisible(NOW, days(1), minutes(5))).toBe(false);
  });

  it('expires after the 7-day window even with no forward since', () => {
    // An uninstalled embed or a one-off incident should not nag forever.
    expect(isDropBannerVisible(NOW, new Date(NOW.getTime() - DROP_BANNER_WINDOW_MS - 1), null)).toBe(false);
    expect(isDropBannerVisible(NOW, days(6), null)).toBe(true);
  });
});

describe('isStaleUninstall — the reinstall guard', () => {
  const triggeredAt = NOW.getTime();

  it('honors the uninstall when nothing postdates the event', () => {
    expect(isStaleUninstall(triggeredAt, minutes(10), minutes(20))).toBe(false);
    expect(isStaleUninstall(triggeredAt, null, null)).toBe(false);
  });

  it('skips the wipe when settings were re-saved after the event fired', () => {
    expect(isStaleUninstall(triggeredAt, new Date(triggeredAt + 1), null)).toBe(true);
  });

  it('skips the wipe when a session was created after the event fired', () => {
    // Covers the window where the merchant reinstalled (OAuth done, Session
    // row written) but has not yet re-pasted keys — the settings check alone
    // wiped their fresh login mid-setup.
    expect(isStaleUninstall(triggeredAt, minutes(10), new Date(triggeredAt + 1))).toBe(true);
    expect(isStaleUninstall(triggeredAt, null, new Date(triggeredAt + 1))).toBe(true);
  });

  it('never skips the wipe on an unparseable trigger time', () => {
    // When we cannot prove the event is stale, honoring it is the safe default.
    expect(isStaleUninstall(NaN, new Date(), new Date())).toBe(false);
  });
});
