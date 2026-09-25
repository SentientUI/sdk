/**
 * `@sentientui/core/region`: region skeleton capture and fingerprinting for
 * the React SDK, the snippet and the API. Split from the lean entry for bundle
 * size — see region-capture.ts.
 */
export { captureRegionDom, captureRegionSkeleton, normalizeLeafText, regionAddress, skeletonFingerprint } from './region-capture.js';
export type { RegionAddress } from './region-capture.js';
