export { AdaptiveProvider, useSentient, useInitialAssignments, useLayoutOrder, useAdaptiveApiBaseUrl } from './provider.js';
export type { AdaptiveProviderProps, SsrFallback } from './provider.js';

export { Adaptive } from './adaptive.js';
export type {
  AdaptiveProps,
  GoalConfig,
  ClickGoal,
  ScrollDepthGoal,
  FormSubmitGoal,
  CompositeGoal,
  WeightedStep,
  WeightedCompositeGoal,
  MicroSignalGoals,
  MicroSignalGoalConfig,
} from './adaptive.js';

export { AdaptiveText } from './adaptive-text.js';
export type { AdaptiveTextProps } from './adaptive-text.js';

/**
 * @deprecated Use {@link useAdaptive} instead — it selects a variant AND wires
 * exposure, goal, and micro-signal tracking. `useAssignment` only selects, so a
 * component built on it directly records no learning signal. Kept exported for
 * back-compat (it is `useAdaptive`'s internal selection engine); moving to
 * internal-only in 1.0.0.
 */
export { useAssignment } from './use-assignment.js';
export type { AssignmentState } from './use-assignment.js';

export { useAdaptiveGoal } from './use-adaptive-goal.js';
export type { FireGoal } from './use-adaptive-goal.js';

export { usePageGoal } from './use-page-goal.js';
export type { PageGoalOptions } from './use-page-goal.js';

export { SentientPersonaScript } from './persona-script.js';
export type { SentientPersonaScriptProps } from './persona-script.js';

export { useAdaptiveTokens } from './use-adaptive-tokens.js';
export type { UseAdaptiveTokensOptions, UseAdaptiveTokensResult } from './use-adaptive-tokens.js';

export { useAdaptive } from './use-adaptive.js';
export type { UseAdaptiveResult, UseAdaptiveBind } from './use-adaptive.js';

export { useAdaptivePersona } from './use-slot-result.js';
export type { AdaptivePersona } from './use-slot-result.js';

export { AdaptiveGroup } from './adaptive-group.js';
export type { AdaptiveGroupProps } from './adaptive-group.js';

export type { ComponentWeights, VariantWeight } from './weights-store.js';

export { detectSegment } from './segment.js';

export {
  defineAgentContent,
  getAgentContent,
  buildAgentFeed,
  renderAgentJsonLd,
  renderAgentJsonLdBody,
  renderAgentMarkdown,
} from './agent-feed.js';
export type { AgentFeed, AgentBlock } from './agent-feed.js';

// Re-exported from core so a React app can wire its consent banner to the SDK
// without adding @sentientui/core as a direct dependency — the docs already
// point React users at grantConsent(), so it belongs on this entry.
//
// Safe here, unlike the server-only helpers re-exported from /next: this index
// carries no 'use client' directive, and grantConsent is browser-only (it
// returns immediately during SSR), so it is only ever called from a client
// component and never becomes a client reference invoked on the server.
export { grantConsent } from '@sentientui/core';
