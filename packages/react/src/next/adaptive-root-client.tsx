'use client';

import type { ReactNode } from 'react';
// Import from the package entry (kept `external` in tsup) — NOT the relative
// '../provider.js'. A relative import makes tsup inline a second copy of
// provider.js into this /next bundle, which runs createContext() again and
// yields a DISTINCT AdaptiveContext. The result: <AdaptiveRoot> populates its
// own context while useSentient()/<Adaptive> (from the main entry) read a
// different one that stays {client:null} forever — so no events/goals ever
// fire. Importing the package specifier shares the single context singleton.
import { AdaptiveProvider, type AdaptiveProviderProps } from '@sentientui/react';

export type AdaptiveRootClientProps = AdaptiveProviderProps & {
  children: ReactNode;
};

/** Client boundary for {@link AdaptiveRoot} — keeps context/hooks out of the server bundle. */
export function AdaptiveRootClient(props: AdaptiveRootClientProps): JSX.Element {
  return <AdaptiveProvider {...props} />;
}
