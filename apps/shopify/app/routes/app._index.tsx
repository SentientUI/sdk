import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  Banner,
  TextField,
  List,
  Link,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSettings, provisionSentient, saveSettings } from "../lib/settings.server";
import { isDropBannerVisible } from "../lib/drop-visibility";
import { settingsEncryptionEnabled } from "../lib/secret-box";
import { ensureWebPixel, healWebPixelApiBase } from "../lib/pixel.server";
import {
  PERSONA_TAGS_KEY,
  PERSONA_TAGS_NAMESPACE,
  mappingToText,
  parseTagMapping,
  savePersonaTagMapping,
} from "../lib/persona-mapping.server";

// The settings screen (README step 2): the merchant creates the project in the
// SentientUI dashboard first, then pastes its two keys here. Saving stores
// them per shop (sk_ stays server-side) and calls the idempotent
// /v1/provision/shopify bootstrap; the theme embed carries the pk_ via its own
// block setting, which the "Enable" link deep-links the merchant to.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  // The pixel bakes SENTIENT_API_URL into its settings at save time, so an
  // env change stranded every shop's checkout events on the old API until the
  // merchant happened to re-save. Heal it on the admin visit instead: reads
  // the pixel, rewrites only when the stored apiBase differs. Fail-soft.
  if (settings) {
    await healWebPixelApiBase(admin.graphql, settings.publishableKey);
  }
  // Current tag → persona mapping, from the app-owned shop metafield the
  // theme embed reads. Best-effort: a read failure just shows an empty box.
  let mappingText = "";
  try {
    const res = (await (
      await admin.graphql(
        `#graphql query sentientPersonaTagsRead($namespace: String!, $key: String!) {
          shop { metafield(namespace: $namespace, key: $key) { value } }
        }`,
        { variables: { namespace: PERSONA_TAGS_NAMESPACE, key: PERSONA_TAGS_KEY } },
      )
    ).json()) as { data?: { shop?: { metafield?: { value: string } | null } } };
    const raw = res.data?.shop?.metafield?.value;
    if (raw) mappingText = mappingToText(JSON.parse(raw) as Record<string, string>);
  } catch {
    /* empty box */
  }
  return json({
    shop: session.shop,
    publishableKey: settings?.publishableKey ?? "",
    // The sk_ is never echoed back — only whether one is stored.
    hasSecretKey: Boolean(settings?.secretKey),
    // secret-box.ts silently degrades to plaintext when the env key is unset —
    // the screen must say so, or the downgrade is invisible until a breach.
    encryptionEnabled: settingsEncryptionEnabled(),
    // Webhook health: a terminal drop (rotated sk_ → 401) used to live only in
    // Fly logs. Recent drop with no forward since → warn the merchant; a
    // forward newer than the drop clears the banner with no manual dismissal.
    droppedRecently: isDropBannerVisible(
      new Date(),
      settings?.lastDropAt ?? null,
      settings?.lastForwardAt ?? null,
    ),
    // Formatted server-side: toLocaleString in the component would render
    // differently on server and client (locale/timezone) and trip hydration.
    lastDropAtDisplay: settings?.lastDropAt?.toISOString().replace('T', ' ').slice(0, 16).concat(' UTC') ?? null,
    lastDropReason: settings?.lastDropReason ?? null,
    mappingText,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const publishableKey = String(form.get("publishableKey") ?? "").trim();
  const secretKey = String(form.get("secretKey") ?? "").trim();
  const mappingText = String(form.get("mappingText") ?? "");

  if (!publishableKey.startsWith("pk_")) {
    return json({ ok: false as const, error: "The publishable key should start with pk_." });
  }
  // The sk_ is never echoed back, so an empty field on a re-save means "keep
  // the stored one" — otherwise every settings tweak would demand a re-paste.
  const stored = await getSettings(session.shop);
  const effectiveSecret = secretKey || stored?.secretKey || "";
  if (!effectiveSecret.startsWith("sk_")) {
    return json({ ok: false as const, error: "The secret key should start with sk_." });
  }
  const parsedMapping = parseTagMapping(mappingText);
  if (!parsedMapping.ok) {
    return json({ ok: false as const, error: `Audience mapping: ${parsedMapping.error}` });
  }

  await saveSettings(session.shop, publishableKey, effectiveSecret);
  const provisioned = await provisionSentient(effectiveSecret);
  // Activate/refresh the app's web pixel with the current key (fast browser
  // path + upstream funnel steps), and persist the tag → persona mapping to
  // the shop metafield the theme embed reads. Both fail-soft.
  const pixel = await ensureWebPixel(admin.graphql, publishableKey);
  const pixelOk = pixel.ok;
  const mappingOk = await savePersonaTagMapping(admin.graphql, parsedMapping.mapping);

  const warnings = [
    provisioned ? null : "reaching SentientUI to set up the purchase goal failed — check the secret key and save again",
    pixelOk ? null : `activating the checkout pixel failed (${pixel.reason ?? 'unknown'}) — funnel steps won't be tracked until a later save succeeds`,
    mappingOk ? null : "saving the audience mapping failed — try saving again",
  ].filter(Boolean);
  return json({
    ok: true as const,
    provisioned,
    pixelOk,
    mappingOk,
    error: warnings.length > 0 ? `Keys saved, but ${warnings.join("; ")}.` : null,
  });
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const [publishableKey, setPublishableKey] = useState(data.publishableKey);
  const [secretKey, setSecretKey] = useState("");
  const [mappingText, setMappingText] = useState(data.mappingText);

  return (
    <Page>
      <TitleBar title="SentientUI" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Connect your SentientUI project
                </Text>
                {/* encryptSecret writes PLAINTEXT when SETTINGS_ENCRYPTION_KEY
                    is unset (deliberate degrade, see secret-box.ts) — without
                    this banner a lost env var downgraded every subsequent save
                    silently. */}
                {!data.encryptionEnabled && (
                  <Banner tone="warning">
                    Secret-key encryption is off: SETTINGS_ENCRYPTION_KEY is not set on the app
                    server, so saved keys are stored unencrypted. Everything still works, but the
                    operator should set the key (deploy runbook) — keys re-encrypt on the next save.
                  </Banner>
                )}
                {data.droppedRecently && (
                  <Banner tone="critical" title="Some orders are not reaching SentientUI">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd">
                        An order or refund could not be delivered to SentientUI and will not be
                        retried
                        {data.lastDropAtDisplay ? ` (last time: ${data.lastDropAtDisplay})` : ""}
                        . The usual cause is a rotated or revoked secret key — check your API keys
                        in the SentientUI dashboard and paste the current secret key below. This
                        warning clears on its own once orders start flowing again.
                      </Text>
                      {data.lastDropReason && (
                        <Text as="p" tone="subdued" variant="bodySm">
                          Details: {data.lastDropReason}
                        </Text>
                      )}
                    </BlockStack>
                  </Banner>
                )}
                {result && "error" in result && result.error && (
                  <Banner tone={result.ok ? "warning" : "critical"}>{result.error}</Banner>
                )}
                {result?.ok && !result.error && (
                  <Banner tone="success">
                    Connected. Purchase goal, checkout funnel, checkout pixel, and audience mapping are all set.
                  </Banner>
                )}
                <Text as="p" variant="bodyMd">
                  Create a project in the{" "}
                  <Link url="https://sentient-ui.com" target="_blank">
                    SentientUI dashboard
                  </Link>{" "}
                  and paste its API keys here (Settings → API keys).
                </Text>
                <Form method="post">
                  <BlockStack gap="300">
                    <TextField
                      label="Publishable key"
                      name="publishableKey"
                      autoComplete="off"
                      value={publishableKey}
                      onChange={setPublishableKey}
                      placeholder="pk_…"
                      helpText="Used by the storefront snippet. Safe to expose publicly."
                    />
                    <TextField
                      label="Secret key"
                      name="secretKey"
                      autoComplete="off"
                      type="password"
                      value={secretKey}
                      onChange={setSecretKey}
                      placeholder={data.hasSecretKey ? "•••••••• (saved — paste again to replace)" : "sk_…"}
                      helpText="Stays on the app's server; used to report orders and refunds."
                    />
                    <TextField
                      label="Audience mapping (optional)"
                      name="mappingText"
                      autoComplete="off"
                      multiline={4}
                      value={mappingText}
                      onChange={setMappingText}
                      placeholder={"wholesale = wholesale\nVIP = vip"}
                      helpText="One per line: customer tag = SentientUI persona key (dashboard → Settings → Personas). Logged-in customers with a matching tag are served as that audience; typos surface as a nudge in the dashboard, never an error."
                    />
                    <Button submit variant="primary" loading={saving}>
                      Save and connect
                    </Button>
                  </BlockStack>
                </Form>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Finish the install
                </Text>
                <List type="number">
                  <List.Item>Save your keys here.</List.Item>
                  <List.Item>
                    <Link
                      url={`https://${data.shop}/admin/themes/current/editor?context=apps`}
                      target="_blank"
                    >
                      Enable the SentientUI embed
                    </Link>{" "}
                    in your theme (App embeds → SentientUI) and paste the publishable key there.
                  </List.Item>
                  <List.Item>
                    Place a test order — it appears as a purchase in your SentientUI dashboard.
                  </List.Item>
                  <List.Item>
                    Try a different look: open your storefront from the{" "}
                    <Link url="https://sentient-ui.com" target="_blank">
                      SentientUI dashboard
                    </Link>{" "}
                    (Components → Edit on site), pick a section, and choose{" "}
                    <b>Try a different arrangement</b> — ready-made section designs, tested
                    against your page as it is today.
                  </List.Item>
                </List>
                <Text as="p" tone="subdued" variant="bodySm">
                  Orders and refunds are reported server-side; your storefront only ever sees the
                  publishable key.
                </Text>
              </BlockStack>
            </Card>

            {/* Say the pricing model plainly here rather than let a merchant
                discover it at a paywall. The app is free; the subscription is
                on the SentientUI account and scales with traffic, so a small
                store pays little and nobody pays twice for the same thing. */}
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  What this costs
                </Text>
                <Text as="p" variant="bodySm">
                  The app is free. You pay for SentientUI itself, on your{" "}
                  <Link url="https://sentient-ui.com/settings/billing" target="_blank">
                    SentientUI account
                  </Link>
                  , priced on the traffic it optimizes — so it scales with your store rather
                  than charging a flat fee for the connector. There is a free tier to start.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
