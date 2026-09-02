// Web pixel activation (B4 pixel path). App-owned web pixels are NOT toggled
// by the merchant — the app activates its own pixel via the Admin API, with
// the settings the extension toml declares. Called on every settings save so
// the pixel always carries the current publishableKey (create first; a TAKEN
// error means it already exists → update in place). Requires the write_pixels
// scope. Fail-soft: a pixel error must not block saving keys — the webhook
// truth path works without it; only the fast browser path and the upstream
// funnel steps wait on the pixel.
import { sentientApiUrl } from './settings.server';

type GraphqlFn = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<{ json(): Promise<unknown> }>;

const CREATE = `#graphql
  mutation sentientPixelCreate($webPixel: WebPixelInput!) {
    webPixelCreate(webPixel: $webPixel) {
      webPixel { id }
      userErrors { code field message }
    }
  }`;

const UPDATE = `#graphql
  mutation sentientPixelUpdate($id: ID!, $webPixel: WebPixelInput!) {
    webPixelUpdate(id: $id, webPixel: $webPixel) {
      webPixel { id }
      userErrors { code field message }
    }
  }`;

const CURRENT = `#graphql
  query sentientPixelCurrent { webPixel { id } }`;

type PixelPayload = {
  webPixel?: { id: string } | null;
  userErrors?: Array<{ code?: string | null; message?: string | null }>;
};

function describeErrors(errors: Array<{ code?: string | null; message?: string | null }> | undefined, raw: unknown): string {
  if (errors && errors.length > 0) return errors.map((e) => `${e.code ?? '?'}: ${e.message ?? ''}`).join('; ');
  // No userErrors and no pixel: a top-level GraphQL error (e.g. missing scope)
  // — surface the raw payload so the banner can say WHY.
  try { return JSON.stringify(raw).slice(0, 300); } catch { return 'unknown error'; }
}

export async function ensureWebPixel(
  graphql: GraphqlFn,
  publishableKey: string,
): Promise<{ ok: boolean; reason?: string }> {
  const settings = JSON.stringify({ publishableKey, apiBase: sentientApiUrl() });
  try {
    const created = (await (await graphql(CREATE, { variables: { webPixel: { settings } } })).json()) as {
      data?: { webPixelCreate?: PixelPayload };
      errors?: unknown;
    };
    const createResult = created.data?.webPixelCreate;
    if (createResult?.webPixel?.id) return { ok: true };
    const taken = (createResult?.userErrors ?? []).some((e) => e.code === 'TAKEN');
    if (!taken) return { ok: false, reason: describeErrors(createResult?.userErrors, created) };

    const current = (await (await graphql(CURRENT)).json()) as { data?: { webPixel?: { id: string } | null } };
    const id = current.data?.webPixel?.id;
    if (!id) return { ok: false, reason: 'pixel reported TAKEN but none found to update' };
    const updated = (await (await graphql(UPDATE, { variables: { id, webPixel: { settings } } })).json()) as {
      data?: { webPixelUpdate?: PixelPayload };
    };
    if (updated.data?.webPixelUpdate?.webPixel?.id) return { ok: true };
    return { ok: false, reason: describeErrors(updated.data?.webPixelUpdate?.userErrors, updated) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 300) : 'request failed' };
  }
}
