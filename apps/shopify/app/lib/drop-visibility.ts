// Pure decision logic for merchant-visible webhook health (SHOP-3) and the
// uninstall staleness guard (SHOP-11). Kept free of Prisma/Remix so the rules
// are unit-testable — the subtle bits here are all time comparisons, exactly
// the kind of logic that regresses silently inside a route handler.

/** How long a terminal drop stays banner-worthy. Old drops from an incident
 *  the merchant already fixed should not nag forever. */
export const DROP_BANNER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** lastForwardAt write throttle. Every orders/paid succeeding on a busy shop
 *  must not become a DB write per webhook — the timestamp only has to be
 *  fresh enough to outrank a drop, not exact. */
export const FORWARD_RECORD_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Whether a successful forward should write lastForwardAt now.
 *
 * Cheap-write guard: skip when the stored timestamp is under an hour old —
 * EXCEPT when a drop was recorded after it. Without that exception, a drop
 * followed within the hour by a recovered forward left lastForwardAt older
 * than lastDropAt, so the warning banner kept showing for up to an hour after
 * the merchant had already fixed the key.
 */
export function shouldRecordForward(
  now: Date,
  lastForwardAt: Date | null,
  lastDropAt: Date | null,
): boolean {
  if (!lastForwardAt) return true;
  if (lastDropAt && lastDropAt.getTime() > lastForwardAt.getTime()) return true;
  return now.getTime() - lastForwardAt.getTime() >= FORWARD_RECORD_INTERVAL_MS;
}

/**
 * Whether the settings screen should warn about dropped revenue webhooks:
 * a drop happened recently AND no forward has succeeded since. A forward
 * newer than the drop is the natural all-clear — the merchant fixed the key
 * (or the API recovered) and orders are flowing again, so no manual dismissal
 * is needed.
 */
export function isDropBannerVisible(
  now: Date,
  lastDropAt: Date | null,
  lastForwardAt: Date | null,
): boolean {
  if (!lastDropAt) return false;
  if (now.getTime() - lastDropAt.getTime() > DROP_BANNER_WINDOW_MS) return false;
  return !lastForwardAt || lastForwardAt.getTime() <= lastDropAt.getTime();
}

/**
 * Whether an app/uninstalled delivery is stale — i.e. the shop reinstalled
 * AFTER this uninstall fired, so wiping now would log the merchant out and
 * disconnect a live install. Shopify retries app/uninstalled for 48h, so a
 * duplicate can land well after the merchant reinstalled and re-pasted keys.
 *
 * Two independent "the install is newer than the event" signals:
 *  - settings.updatedAt — the merchant saved keys since the uninstall fired.
 *    Misses the window between reinstall (OAuth done) and the key re-paste,
 *    where a wipe still logs them out mid-setup — hence the second signal:
 *  - the newest Session row's createdAt — OAuth completed since the uninstall
 *    fired. Sessions are deleted on the first (non-stale) uninstall delivery,
 *    so a row created after triggeredAt can only mean a reinstall.
 *
 * An unparseable trigger time (NaN) never skips the wipe: when we cannot
 * prove the event is stale, honoring the uninstall is the safe default.
 */
export function isStaleUninstall(
  triggeredAt: number,
  settingsUpdatedAt: Date | null,
  newestSessionCreatedAt: Date | null,
): boolean {
  if (!Number.isFinite(triggeredAt)) return false;
  if (settingsUpdatedAt && settingsUpdatedAt.getTime() > triggeredAt) return true;
  if (newestSessionCreatedAt && newestSessionCreatedAt.getTime() > triggeredAt) return true;
  return false;
}
