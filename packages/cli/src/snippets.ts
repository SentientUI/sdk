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
  return `[sentientui] could not detect a supported framework (Next.js, Vite, Remix, CRA).
Manual setup:
  1. Install the SDK:        npm install @sentientui/react
  2. Wrap your app root in:  <AdaptiveProvider apiKey=""${consent ? ` consentFrom="${consent}"` : ''}>…</AdaptiveProvider>
  3. Leave the key empty for local mode; decisions are simulated on-device.
  4. Open your app with ?sentient_persona=a, then ?sentient_persona=b, to preview two personas
     (keyless local mode accepts any key).`;
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

export function finale(framework: Framework): string {
  const port = framework === 'vite' ? 5173 : 3000;
  // Any key works in keyless local mode. This used to name one of
  // the four seeded personas removed 2026-09-13 — against a real project that key no
  // longer exists, so the example read as a persona the SDK ships with.
  return `open http://localhost:${port}?sentient_persona=a (then ?sentient_persona=b)`;
}
