/**
 * Server-only entry (`@sentientui/core/server`). SSR preload helpers that are
 * never needed in the browser — kept out of the lean client bundle.
 */

export { preloadAssignments, readSessionCookie, preloadDecisions } from './server.js';
export type { ServerAssignConfig, ServerAssignments, DecideResult, SlotDeclInput, SlotResult } from './server.js';

export {
  deriveSessionSegment,
  buildSessionUpsertPayload,
  detectDeviceClass,
  detectTrafficSource,
  detectTimeOfDay,
  referrerDomainFromReferer,
} from './session-meta.js';
export type { SessionUpsertPayload } from './session-meta.js';
