/**
 * Your app's goal ids, for autocomplete and typo checks. Declare them once,
 * anywhere in your app's TypeScript:
 *
 *   declare module '@sentientui/react' {
 *     interface Register { goal: 'signup' | 'viewed_pricing' | 'purchase' }
 *   }
 *
 * Every goal name the SDK takes — `useGoal`, `usePageGoal`, the fire function
 * from `useAdaptiveGoal`, the `goal` prop on `<Adaptive>` and the other
 * components — then accepts only those. A misspelled goal is not an error at
 * runtime: it records a goal of its own that never matches the one you meant,
 * and a misspelled main goal reads 0% forever. Without the declaration every
 * name is a plain string, as before.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Register {}

/** A goal id: the union declared on `Register['goal']`, else any string. */
export type GoalName = Register extends { goal: infer G extends string } ? G : string;
