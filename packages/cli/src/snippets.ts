import type { Framework } from './detect.js';

/** The consent presets `--consent` accepts (the SDK's `consentFrom` presets). */
export const CONSENT_PRESETS = ['cookiebot', 'onetrust', 'cookieyes', 'tcf', 'google-consent-mode', 'shopify'] as const;
export type ConsentPreset = (typeof CONSENT_PRESETS)[number];

export function wrapSnippet(framework: Framework, envVar: string, consent?: ConsentPreset): string {
  // Rendered into the provider tag: with --consent the SDK waits for the
  // platform; without it the snippet stays as-is and consentNote() says so.
  const c = consent ? ` consentFrom="${consent}"` : '';
  switch (framework) {
    case 'next-app':
      // AdaptiveRoot, not AdaptiveProvider: the App Router layout is a Server
      // Component, and only AdaptiveRoot resolves the decision server-side and
      // renders the pre-paint persona script. The provider here meant no SSR
      // assignment (a flash on first paint) and no persona attributes at all.
      return `// app/layout.tsx — keep this a Server Component (no 'use client')
import { AdaptiveRoot } from '@sentientui/react/next';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning is required: AdaptiveRoot's inline script sets
    // attributes on <html> before first paint.
    <html lang="en" suppressHydrationWarning>
      <body>
        <AdaptiveRoot apiKey={process.env.${envVar} ?? ''}${c}>
          {children}
        </AdaptiveRoot>
      </body>
    </html>
  );
}`;
    case 'next-pages':
      return `// pages/_app.tsx
import type { AppProps } from 'next/app';
import { AdaptiveProvider } from '@sentientui/react';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <AdaptiveProvider apiKey={process.env.${envVar} ?? ''}${c}>
      <Component {...pageProps} />
    </AdaptiveProvider>
  );
}`;
    case 'vite':
      return `// src/main.tsx
import { createRoot } from 'react-dom/client';
import { AdaptiveProvider } from '@sentientui/react';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <AdaptiveProvider apiKey={import.meta.env.${envVar} ?? ''}${c}>
    <App />
  </AdaptiveProvider>,
);`;
    case 'remix':
      // Remix v2 is Vite-powered, so the client reads VITE_-prefixed vars from
      // import.meta.env (envVar is VITE_SENTIENT_API_KEY for remix).
      return `// app/root.tsx — wrap your <Outlet /> inside <body>
import { AdaptiveProvider } from '@sentientui/react';

// inside the Layout/App component body:
<AdaptiveProvider apiKey={import.meta.env.${envVar} ?? ''}${c}>
  <Outlet />
</AdaptiveProvider>`;
    case 'react-router':
      // React Router v7 framework mode is Remix's successor: same app/root.tsx
      // shape, Vite-powered, so the client reads VITE_ vars from import.meta.env.
      return `// app/root.tsx — wrap your <Outlet /> inside <body>
import { AdaptiveProvider } from '@sentientui/react';

// inside the Layout/App component body:
<AdaptiveProvider apiKey={import.meta.env.${envVar} ?? ''}${c}>
  <Outlet />
</AdaptiveProvider>`;
    case 'gatsby':
      // Gatsby has no single root component: the provider goes in BOTH
      // wrapRootElement hooks, or SSR-built pages and the browser runtime
      // disagree. Only GATSBY_-prefixed vars reach the browser bundle.
      return `// gatsby-browser.tsx AND gatsby-ssr.tsx (same export in both files)
import * as React from 'react';
import { AdaptiveProvider } from '@sentientui/react';

export const wrapRootElement = ({ element }: { element: React.ReactNode }) => (
  <AdaptiveProvider apiKey={process.env.${envVar} ?? ''}${c}>
    {element}
  </AdaptiveProvider>
);`;
    case 'astro':
      // Astro renders React as isolated islands: there is no app-wide React
      // root to wrap, and a provider in one island is invisible to another.
      // Saying "wrap your app" here sent people looking for a root that does
      // not exist; each hydrated island carries its own provider instead.
      return `// Astro has no app-wide React root: wrap INSIDE each React island that uses SentientUI.
// src/components/AdaptiveIsland.tsx
import { AdaptiveProvider } from '@sentientui/react';
import { AdaptiveExampleHero } from './adaptive-example';

export default function AdaptiveIsland() {
  return (
    <AdaptiveProvider apiKey={import.meta.env.${envVar} ?? ''}${c}>
      <AdaptiveExampleHero />
    </AdaptiveProvider>
  );
}

// then in a .astro page (needs @astrojs/react) — client:load so it hydrates:
// <AdaptiveIsland client:load />`;
    case 'cra':
      return `// src/index.tsx
import { createRoot } from 'react-dom/client';
import { AdaptiveProvider } from '@sentientui/react';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <AdaptiveProvider apiKey={process.env.${envVar} ?? ''}${c}>
    <App />
  </AdaptiveProvider>,
);`;
    case 'unknown':
      return unknownInstructions();
  }
}

export function unknownInstructions(consent?: ConsentPreset): string {
  return `[sentientui] could not detect a supported framework (Next.js, React Router v7, Remix, Gatsby, Astro, Vite, CRA).
Manual setup:
  1. Install the SDK:        npm install @sentientui/react
  2. Wrap your app root in:  <AdaptiveProvider apiKey=""${consent ? ` consentFrom="${consent}"` : ''}>…</AdaptiveProvider>
  3. Leave the key empty for local mode; decisions are simulated on-device.
  4. ${VERIFY_HINT}`;
}

/** Printed after the snippet. Tracking is default-on, so an install made
 *  without --consent tracks every visitor from first paint (audit S6). */
export function consentNote(consent?: ConsentPreset): string {
  if (consent) {
    return `Consent: tracking waits for ${consent} to grant, stops on withdrawal, and forgets the visitor on a recorded refusal.`;
  }
  return [
    'Consent: none configured — tracking starts on first paint for every visitor.',
    '  EU/UK visitors need consent first. Re-run with --consent <cookiebot|onetrust|cookieyes|tcf|google-consent-mode|shopify>,',
    '  or add consentFrom={{ cookie, value, event }} for your own banner. https://sentient-ui.com/docs#consent',
  ].join('\n');
}

/**
 * How to check the install worked. This used to say the page should "render
 * differently" under two ?sentient_persona= values — a check the CLI's own
 * scaffold can never pass: the example <Adaptive> renders its original
 * children until a version is published from the dashboard, and keyless local
 * mode has no dashboard, so both URLs looked identical and a working install
 * read as broken. What keyless mode DOES do is honour ?sentient_persona= (any
 * well-formed key) and write it to <html data-sentient-persona> once the SDK
 * decides, so that attribute is the observable check. It is written once per
 * page load (single-writer), hence "reload", not client-side navigation.
 */
export const VERIFY_HINT =
  'Verify: load the page with ?sentient_persona=a and check that <html> carries data-sentient-persona="a"\n' +
  '     (devtools console: document.documentElement.dataset.sentientPersona), then reload with ?sentient_persona=b\n' +
  '     and see "b". Keyless local mode accepts any key; the example itself keeps showing its original\n' +
  '     until a version is published from the dashboard (that needs a real pk_ key).';

export function devPort(framework: Framework): number {
  switch (framework) {
    case 'vite':
    case 'react-router':
      return 5173;
    case 'astro':
      return 4321;
    case 'gatsby':
      return 8000;
    default:
      return 3000;
  }
}

export function finale(framework: Framework): string {
  // Any key works in keyless local mode. This used to name one of
  // the four seeded personas removed 2026-09-13 — against a real project that key no
  // longer exists, so the example read as a persona the SDK ships with.
  return `open http://localhost:${devPort(framework)}/?sentient_persona=a\n${VERIFY_HINT}`;
}
