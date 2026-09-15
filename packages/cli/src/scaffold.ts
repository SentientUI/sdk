import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The example used to be a useAdaptiveTokens hero. With a real key a tokens
// slot only decides when it is also declared in `slots` on AdaptiveRoot — which
// the printed wrap snippet never did — so the scaffold looked live and silently
// served its baseline forever. A generated <Adaptive> needs no declaration: the
// id alone registers it and the dashboard supplies the versions.
const EXAMPLE = `import { Adaptive } from '@sentientui/react';

/**
 * SentientUI example — an adaptive hero.
 *
 * The markup inside <Adaptive> is your original. Versions of it are generated
 * and published from the dashboard (no redeploy), and each visitor is served
 * the one that best drives \`goal\` for visitors like them. Until a version is
 * published — and always in keyless local mode, which has no dashboard — every
 * visitor sees exactly this original.
 *
 * Mount it on any page, visit that page once with your API key set, and the
 * "hero-cta" component appears in the dashboard ready to generate versions.
 */
export function AdaptiveExampleHero() {
  return (
    <Adaptive id="hero-cta" goal="signup_click">
      <section className="adaptive-hero">
        <h1>Ship faster with less guesswork</h1>
        <p>Your original copy stays the baseline every version is measured against.</p>
        <button type="button">Get started</button>
      </section>
    </Adaptive>
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
