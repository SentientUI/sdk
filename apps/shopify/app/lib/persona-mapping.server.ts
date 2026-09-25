// Customer-tag → persona mapping (B4.4). The mapping is stored as an
// app-owned shop metafield so the THEME EMBED can read it in Liquid
// (app.metafields) and declare the persona through the snippet's existing
// `window.sentient.persona` — no new wire anywhere. Unrecognized persona keys
// are harmless by design: the API ignores them and surfaces a "your app sent
// 'x' — add it?" nudge in the dashboard, so a typo self-diagnoses.
type GraphqlFn = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<{ json(): Promise<unknown> }>;

// App-DATA metafields (owner = the app installation): that is what Liquid's
// `app.metafields.config.*` reads in the theme embed. These were written to
// the SHOP under `$app:config`, which the `app` object does not expose, so the
// storefront never saw the tag mapping. LEGACY_* is read once by the settings
// screen so a mapping saved the old way is carried over on the next save.
export const PERSONA_TAGS_NAMESPACE = 'config';
export const LEGACY_PERSONA_TAGS_NAMESPACE = '$app:config';
export const PERSONA_TAGS_KEY = 'persona_tags';
/** The project's pk_, read by the theme embed when its own field is blank —
 *  merchants pasted the same key twice, once here and once in the theme
 *  editor, and a mismatch between the two was silent (audit H10). */
export const PUBLIC_KEY_KEY = 'publishable_key';

const TAG_RE = /^[^=]{1,64}$/;
const PERSONA_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Parse "tag = persona_key" lines (one per line). Invalid lines are reported,
 *  not silently dropped — a mapping the merchant thinks exists but doesn't is
 *  the worst outcome. */
export function parseTagMapping(text: string): { ok: true; mapping: Record<string, string> } | { ok: false; error: string } {
  const mapping: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const eq = line.indexOf('=');
    if (eq === -1) return { ok: false, error: `"${line}" — use the form: tag = persona_key` };
    const tag = line.slice(0, eq).trim();
    const persona = line.slice(eq + 1).trim().toLowerCase();
    if (!tag || !TAG_RE.test(tag)) return { ok: false, error: `"${line}" — the tag part looks wrong` };
    if (!PERSONA_KEY_RE.test(persona)) {
      return { ok: false, error: `"${line}" — persona keys are lowercase letters/numbers/underscores (see Settings → Personas in your SentientUI dashboard)` };
    }
    mapping[tag] = persona;
    if (Object.keys(mapping).length > 50) return { ok: false, error: 'That is a lot of mappings — keep it under 50.' };
  }
  return { ok: true, mapping };
}

/** Render a stored mapping back into the editable "tag = persona" text. */
export function mappingToText(mapping: Record<string, string>): string {
  return Object.entries(mapping).map(([tag, persona]) => `${tag} = ${persona}`).join('\n');
}

const INSTALLATION_ID = `#graphql
  query sentientInstallationId { currentAppInstallation { id } }`;

const SET_METAFIELD = `#graphql
  mutation sentientPersonaTags($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }`;

export async function savePersonaTagMapping(
  graphql: GraphqlFn,
  mapping: Record<string, string>,
  publishableKey?: string,
): Promise<boolean> {
  try {
    const inst = (await (await graphql(INSTALLATION_ID)).json()) as { data?: { currentAppInstallation?: { id: string } } };
    const ownerId = inst.data?.currentAppInstallation?.id;
    if (!ownerId) return false;
    const res = (await (
      await graphql(SET_METAFIELD, {
        variables: {
          metafields: [
            {
              ownerId,
              namespace: PERSONA_TAGS_NAMESPACE,
              key: PERSONA_TAGS_KEY,
              type: 'json',
              value: JSON.stringify(mapping),
            },
            ...(publishableKey
              ? [{ ownerId, namespace: PERSONA_TAGS_NAMESPACE, key: PUBLIC_KEY_KEY, type: 'single_line_text_field', value: publishableKey }]
              : []),
          ],
        },
      })
    ).json()) as { data?: { metafieldsSet?: { metafields?: Array<{ id: string }>; userErrors?: Array<{ message?: string }> } } };
    return (res.data?.metafieldsSet?.metafields?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
