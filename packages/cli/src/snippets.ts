import type { Framework } from './detect.js';

export function wrapSnippet(framework: Framework, envVar: string): string {
  switch (framework) {
    case 'next-app':
      return `// app/layout.tsx
import { AdaptiveProvider } from '@sentientui/react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <AdaptiveProvider apiKey={process.env.${envVar} ?? ''} context="landing">
          {children}
        </AdaptiveProvider>
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
    <AdaptiveProvider apiKey={process.env.${envVar} ?? ''} context="landing">
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
  <AdaptiveProvider apiKey={import.meta.env.${envVar} ?? ''} context="landing">
    <App />
  </AdaptiveProvider>,
);`;
    case 'remix':
      // Remix v2 is Vite-powered, so the client reads VITE_-prefixed vars from
      // import.meta.env (envVar is VITE_SENTIENT_API_KEY for remix).
      return `// app/root.tsx — wrap your <Outlet /> inside <body>
import { AdaptiveProvider } from '@sentientui/react';

// inside the Layout/App component body:
<AdaptiveProvider apiKey={import.meta.env.${envVar} ?? ''} context="landing">
  <Outlet />
</AdaptiveProvider>`;
    case 'cra':
      return `// src/index.tsx
import { createRoot } from 'react-dom/client';
import { AdaptiveProvider } from '@sentientui/react';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <AdaptiveProvider apiKey={process.env.${envVar} ?? ''} context="landing">
    <App />
  </AdaptiveProvider>,
);`;
    case 'unknown':
      return unknownInstructions();
  }
}

export function unknownInstructions(): string {
  return `[sentientui] could not detect a supported framework (Next.js, Vite, Remix, CRA).
Manual setup:
  1. Install the SDK:        npm install @sentientui/react
  2. Wrap your app root in:  <AdaptiveProvider apiKey="" context="landing">…</AdaptiveProvider>
  3. Leave the key empty for local mode; decisions are simulated on-device.
  4. Open your app with ?sentient_persona=buyer to preview a persona.`;
}

export function finale(framework: Framework): string {
  const port = framework === 'vite' ? 5173 : 3000;
  return `open http://localhost:${port}?sentient_persona=buyer`;
}
