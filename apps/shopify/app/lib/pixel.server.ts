// Web pixel activation (B4 pixel path). App-owned web pixels are NOT toggled
// by the merchant — the app activates its own pixel via the Admin API, with
// the settings the extension toml declares. Called on every settings save so
// the pixel always carries the current publishableKey (look the pixel up
// first: update in place when it exists, create only when it doesn't).
// Requires the write_pixels scope. Fail-soft: a pixel error must not block saving keys — the webhook
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

// Same lookup plus the stored settings JSON, for the apiBase staleness check.
const CURRENT_WITH_SETTINGS = `#graphql
  query sentientPixelCurrentSettings { webPixel { id settings } }`;

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
    const update = async (id: string): Promise<{ ok: boolean; reason?: string }> => {
      const updated = (await (await graphql(UPDATE, { variables: { id, webPixel: { settings } } })).json()) as {
        data?: { webPixelUpdate?: PixelPayload };
      };
      if (updated.data?.webPixelUpdate?.webPixel?.id) return { ok: true };
      return { ok: false, reason: describeErrors(updated.data?.webPixelUpdate?.userErrors, updated) };
    };

    // Re-saves are the common case, and creating first fired a guaranteed-fail
    // create (TAKEN) on every one of them — an error-shaped exchange on the
    // healthy path. Query first; only a shop with no pixel yet creates. (When
    // none exists the query answers with a top-level error and no data, which
    // reads as `undefined` here — that is the create case, not a failure.)
    const current = (await (await graphql(CURRENT)).json()) as { data?: { webPixel?: { id: string } | null } };
    const existingId = current.data?.webPixel?.id;
    if (existingId) return update(existingId);

    const created = (await (await graphql(CREATE, { variables: { webPixel: { settings } } })).json()) as {
      data?: { webPixelCreate?: PixelPayload };
      errors?: unknown;
    };
    const createResult = created.data?.webPixelCreate;
    if (createResult?.webPixel?.id) return { ok: true };
    const taken = (createResult?.userErrors ?? []).some((e) => e.code === 'TAKEN');
    if (!taken) return { ok: false, reason: describeErrors(createResult?.userErrors, created) };

    // TAKEN despite the lookup above: a concurrent save created the pixel
    // between the query and the create. Re-query and update in place.
    const requeried = (await (await graphql(CURRENT)).json()) as { data?: { webPixel?: { id: string } | null } };
    const id = requeried.data?.webPixel?.id;
    if (!id) return { ok: false, reason: 'pixel reported TAKEN but none found to update' };
    return update(id);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 300) : 'request failed' };
  }
}

/**
 * Heals a pixel whose baked-in apiBase went stale (SHOP-10). ensureWebPixel
 * snapshots SENTIENT_API_URL into the pixel settings at save time, so an env
 * change on the app server used to require EVERY merchant to re-save their
 * keys before checkout events pointed at the new API. Called from the
 * authenticated admin loader: one read per visit, and the mutation only fires
 * when the stored apiBase actually differs — nothing changed, nothing written.
 * Fail-soft like the rest of the pixel path: the admin screen must render
 * whatever the pixel is doing.
 */
export async function healWebPixelApiBase(graphql: GraphqlFn, publishableKey: string): Promise<void> {
  try {
    const current = (await (await graphql(CURRENT_WITH_SETTINGS)).json()) as {
      data?: { webPixel?: { id: string; settings?: string | null } | null };
    };
    const pixel = current.data?.webPixel;
    // No pixel yet: the merchant has not had a successful save — creating one
    // here would race the save path for no benefit. Let the save create it.
    if (!pixel?.id) return;
    let storedApiBase: unknown;
    try {
      storedApiBase = (JSON.parse(pixel.settings ?? '{}') as { apiBase?: unknown }).apiBase;
    } catch {
      storedApiBase = undefined; // unparseable settings → treat as stale and rewrite
    }
    if (storedApiBase === sentientApiUrl()) return;
    await ensureWebPixel(graphql, publishableKey);
  } catch {
    // Loader path — a pixel hiccup must never block the settings screen.
  }
}
