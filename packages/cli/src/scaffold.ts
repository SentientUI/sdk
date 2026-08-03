import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const EXAMPLE = `'use client';
import { useAdaptiveTokens } from '@sentientui/react';

/**
 * SentientUI example — Rung 1 (Style): a hero that adapts per visitor persona.
 *
 * The optimizer picks one value per dim ('tone' here) for each visitor and
 * serializes it as data attributes; your CSS does the rest. With no API key
 * the SDK runs in local mode: decisions are simulated deterministically so
 * you can build and style every state before creating an account.
 *
 * Try it: append ?sentient_persona=buyer (or researcher / deal_seeker /
 * browser) to any URL to preview that persona.
 *
 * Canonical persona CSS hooks — copy into your global stylesheet:
 *
 *   .adaptive-hero[data-tone='urgent'] .adaptive-hero-cta { background: #dc2626; }
 *   .adaptive-hero[data-tone='calm']   .adaptive-hero-cta { background: #2563eb; }
 *
 *   html[data-sentient-persona='buyer']       .adaptive-hero-sub::after { content: ' Start in minutes.'; }
 *   html[data-sentient-persona='researcher']  .adaptive-hero-sub::after { content: ' Compare every feature first.'; }
 *   html[data-sentient-persona='deal_seeker'] .adaptive-hero-sub::after { content: ' See what it costs.'; }
 *   html[data-sentient-persona='browser']     .adaptive-hero-sub::after { content: ' Take a look around.'; }
 */
export function AdaptiveExampleHero() {
  const t = useAdaptiveTokens('example-hero', {
    tone: ['calm', 'urgent'], // first value = baseline
  });
  return (
    <section {...t.props} className="adaptive-hero">
      <h1>This hero adapts to every visitor</h1>
      <p className="adaptive-hero-sub">Current tone: {t.tokens.tone}.</p>
      <button className="adaptive-hero-cta">Get started</button>
    </section>
  );
}
`;

/** Writes components/adaptive-example.tsx (src/components when the app uses src/). Never clobbers. */
export function scaffoldExample(cwd: string): string | null {
  const base =
    existsSync(path.join(cwd, 'src')) && !existsSync(path.join(cwd, 'components'))
      ? path.join(cwd, 'src', 'components')
      : path.join(cwd, 'components');
  const file = path.join(base, 'adaptive-example.tsx');
  if (existsSync(file)) return null;
  mkdirSync(base, { recursive: true });
  writeFileSync(file, EXAMPLE, 'utf-8');
  return file;
}
