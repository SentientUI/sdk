/**
 * Production stub for `@sentientui/core/local`. The package.json "./local"
 * exports map resolves here under the `production` condition — and as the
 * fallback for resolvers that set neither condition — so production bundles
 * physically contain no local-engine code.
 */
export const LOCAL_ENGINE_AVAILABLE = false;

export function createLocalEngine(_opts: { sessionId: string; forcedPersona?: string }): never {
  throw new Error(
    '[sentient] createLocalEngine is not available in production builds. ' +
      'The local engine only exists under the `development` export condition.',
  );
}
