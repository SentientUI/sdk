import { describe, it, expect } from 'vitest';
import { wrapSnippet } from './snippets.js';
import { envVarName } from './env-file.js';
import type { Framework } from './detect.js';

// Every framework the CLI advertises must produce a snippet that actually reads
// the user's key from the correct client-exposed env var — never a hardcoded "".
const ADVERTISED: Framework[] = ['next-app', 'next-pages', 'vite', 'remix', 'cra'];

describe('wrapSnippet', () => {
  for (const framework of ADVERTISED) {
    it(`${framework}: reads the key from its env var and never hardcodes apiKey=""`, () => {
      const envVar = envVarName(framework);
      const snippet = wrapSnippet(framework, envVar);
      expect(snippet).toContain(envVar);
      // The provider must interpolate the env var, not receive a hardcoded empty key.
      expect(snippet).toMatch(new RegExp(`apiKey=\\{[^}]*${envVar}`));
      expect(snippet).not.toContain('apiKey=""');
    });
  }

  it('next reads NEXT_PUBLIC via process.env', () => {
    const snippet = wrapSnippet('next-app', envVarName('next-app'));
    expect(snippet).toContain('process.env.NEXT_PUBLIC_SENTIENT_API_KEY');
  });

  it('vite reads VITE_ via import.meta.env', () => {
    const snippet = wrapSnippet('vite', envVarName('vite'));
    expect(snippet).toContain('import.meta.env.VITE_SENTIENT_API_KEY');
  });

  it('remix reads VITE_ via import.meta.env (Remix v2 is Vite-powered)', () => {
    const snippet = wrapSnippet('remix', envVarName('remix'));
    expect(snippet).toContain('import.meta.env.VITE_SENTIENT_API_KEY');
  });

  it('cra reads REACT_APP_ via process.env', () => {
    const snippet = wrapSnippet('cra', envVarName('cra'));
    expect(snippet).toContain('process.env.REACT_APP_SENTIENT_API_KEY');
  });
});
