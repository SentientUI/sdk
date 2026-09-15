/**
 * The one persona key the product itself defines: "we don't know".
 *
 * There is deliberately no persona LIST here. Until 2026-09-13 this module
 * exported a hardcoded four-persona vocabulary (with display names and a
 * plural-label alias map) that every project inherited, and the product
 * presented those names as if it knew the customer's audience. Every persona
 * now comes from the project's own vocabulary — declared by the app or
 * promoted by discovery (see `vocabulary.ts`) — and anything else is
 * `unknown`, which is where the pooled bandit does the actual work.
 */
export const UNKNOWN_PERSONA = 'unknown' as const;

/** Human-facing name of `UNKNOWN_PERSONA`. Every other persona's display name
 *  comes from its vocabulary member, never from a table in this package. */
export const UNKNOWN_PERSONA_DISPLAY = 'Unknown';
