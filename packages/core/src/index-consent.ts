/** `@sentientui/core/consent`: read a visitor's consent from the site's
 *  consent platform (Cookiebot, OneTrust, CookieYes, IAB TCF v2.2, Google
 *  Consent Mode v2, or a cookie/check of your own). Its own entry so installs
 *  that never configure `consentFrom` don't download it. */
export {
  consentWatcher,
  consentFromCookies,
  consentModeGranted,
  tcStringConsents,
  TCF_DEFAULT_PURPOSES,
  tcStringPurposes,
  cookiebotCookieGrants,
  onetrustCookieGrants,
  cookieyesCookieGrants,
} from './consent-sources.js';
export type { ConsentSource, ConsentPreset, ConsentWatcher } from './consent-sources.js';
export { forgetVisitor } from './forget.js';
