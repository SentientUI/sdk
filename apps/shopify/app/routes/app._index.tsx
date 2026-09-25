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
  InlineStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { observeSubscription, reconcilePlan } from "../lib/plan-sync.server";
import { signConnectState } from "../lib/connect-state.server";
import { describeResult, fetchLiftSummary } from "../lib/results.server";
import {
  checkStorefrontOrigin,
  getSettings,
  provisionSentient,
  saveSettings,
  type StorefrontCheck,
  getPendingConnect,
  deletePendingConnect,
  revokeConnectPair,
  confirmPendingConnect,
} from "../lib/settings.server";
import { isDropBannerVisible } from "../lib/drop-visibility";
import { settingsEncryptionEnabled } from "../lib/secret-box";
import { ensureWebPixel, healWebPixelApiBase } from "../lib/pixel.server";
import {
  PERSONA_TAGS_KEY,
  PERSONA_TAGS_NAMESPACE,
  LEGACY_PERSONA_TAGS_NAMESPACE,
  mappingToText,
  parseTagMapping,
  savePersonaTagMapping,
} from "../lib/persona-mapping.server";

/** The shop's primary (custom) domain, when it differs from the myshopify one.
 *  Best-effort: a failed read just means only the myshopify origin gets
 *  allowlisted, which is still enough for the storefront to work. */
async function readPrimaryDomain(
  graphql: Parameters<typeof healWebPixelApiBase>[0],
  shop: string,
): Promise<string | undefined> {
  try {
    const res = (await (
      await graphql(`#graphql query sentientPrimaryDomain { shop { primaryDomain { host } } }`)
    ).json()) as { data?: { shop?: { primaryDomain?: { host?: string } | null } } };
    const host = res.data?.shop?.primaryDomain?.host;
    return host && host !== shop ? host : undefined;
  } catch {
    return undefined;
  }
}

// The settings screen (README step 2): the merchant creates the project in the
// SentientUI dashboard first, then pastes its two keys here. Saving stores
// them per shop (sk_ stays server-side) and calls the idempotent
// /v1/provision/shopify bootstrap; the theme embed carries the pk_ via its own
// block setting, which the "Enable" link deep-links the merchant to.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  const pending = await getPendingConnect(session.shop);
  // Started now, awaited last: the loader's calls ran one after another and a
  // slow API held the admin page ~17 s (review R3 N10).
  const summaryP = settings?.secretKey ? fetchLiftSummary(settings.secretKey) : Promise.resolve(null);
  // The pixel bakes SENTIENT_API_URL into its settings at save time, so an
  // env change stranded every shop's checkout events on the old API until the
  // merchant happened to re-save. Heal it on the admin visit instead: reads
  // the pixel, rewrites only when the stored apiBase differs. Fail-soft.
  // Started now, in parallel with the provisioning chain below (review R4).
  const healP = settings ? healWebPixelApiBase(admin.graphql, settings.publishableKey) : Promise.resolve();

  // Re-affirm the storefront origins on every admin visit, not only on save.
  // Allowlisting used to happen ONLY when the merchant pressed "Save and
  // connect", which made it possible to have a working-looking install whose
  // every storefront request 403s: enable the theme embed without ever
  // saving here, reinstall against an empty production database, or move the
  // store to a custom domain, and the allowlist silently no longer covers the
  // domain visitors actually use. That is what the App Store rejected on
  // 5.1.2 (round 3, 2026-09-21). The call is idempotent and fail-soft, so the
  // cost of doing it here is one cheap request per admin page view.
  let storefrontCheck: StorefrontCheck | null = null;
  let storeDisconnected = false;
  if (settings?.secretKey && settings.publishableKey) {
    const [primaryDomain, observed] = await Promise.all([
      readPrimaryDomain(admin.graphql, session.shop),
      observeSubscription(admin.graphql),
    ]);
    const prov = await provisionSentient(settings.secretKey, {
      shopDomain: session.shop,
      primaryDomain,
      ...(observed.observed ? { subscriptionObserved: observed.observed } : {}),
    });
    storeDisconnected = prov.binding === "disconnected" || prov.binding === "detached";
    // A plan bought before keys were saved (or before a reinstall's keys) was
    // acked and dropped by the webhook; recover it from Shopify's own record.
    // ...then verify it actually took, and say so on the screen. A storefront
    // being turned away is otherwise invisible here — the merchant sees an
    // empty dashboard and no error anywhere. Both after provisioning (which
    // they depend on), in parallel with each other.
    [, storefrontCheck] = await Promise.all([
      // A disconnected store's plan is refused anyway (409).
      storeDisconnected ? Promise.resolve() : reconcilePlan(settings.secretKey, session.shop, observed),
      checkStorefrontOrigin(settings.publishableKey, `https://${session.shop}`),
    ]);
  }
  // Current tag → persona mapping, from the app-data metafield the theme
  // embed reads. Best-effort: a read failure just shows an empty box.
  let mappingText = "";
  try {
    const res = (await (
      await admin.graphql(
        `#graphql query sentientPersonaTagsRead($namespace: String!, $legacy: String!, $key: String!) {
          currentAppInstallation { metafield(namespace: $namespace, key: $key) { value } }
          shop { metafield(namespace: $legacy, key: $key) { value } }
        }`,
        { variables: { namespace: PERSONA_TAGS_NAMESPACE, legacy: LEGACY_PERSONA_TAGS_NAMESPACE, key: PERSONA_TAGS_KEY } },
      )
    ).json()) as {
      data?: {
        currentAppInstallation?: { metafield?: { value: string } | null };
        shop?: { metafield?: { value: string } | null };
      };
    };
    // The installation-owned copy is the live one; the shop-owned one is
    // where earlier builds wrote it, shown so the next save carries it over.
    const raw = res.data?.currentAppInstallation?.metafield?.value ?? res.data?.shop?.metafield?.value;
    if (raw) mappingText = mappingToText(JSON.parse(raw) as Record<string, string>);
  } catch {
    /* empty box */
  }
  const [summary] = await Promise.all([summaryP, healP]);
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
    // A Shopify plan purchase SentientUI did not apply (review R9 M1 / R10
    // L1): shown for 30 days or until a later plan event applies — orders
    // flowing again say nothing about it.
    planIssue:
      settings?.planIssueAt && Date.now() - settings.planIssueAt.getTime() < 30 * 24 * 3600 * 1000
        ? { reason: settings.planIssueReason ?? "", at: settings.planIssueAt.toISOString().replace("T", " ").slice(0, 16).concat(" UTC") }
        : null,
    mappingText,
    storefrontCheck,
    storeDisconnected,
    // A connection delivered by the dashboard, waiting for this merchant's OK.
    dashboardUrl: (process.env.SENTIENT_DASHBOARD_URL ?? "https://sentient-ui.com").replace(/\/$/, ""),
    pendingConnect: pending
      ? { projectName: pending.projectName, projectId: pending.projectId, createdAt: pending.createdAt.toISOString() }
      : null,
    // What SentientUI has measured so far, in words (audit H12).
    results: summary
      ? { ...describeResult(summary), projectId: summary.projectId, computedAt: summary.computedAt.slice(0, 16).replace("T", " ") + " UTC" }
      : null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");

  // Zero-key connect (audit H11). Start: sign a state for THIS shop and send
  // the merchant to the dashboard to pick a project — no keys to copy.
  if (intent === "connect-start") {
    const secret = process.env.SHOPIFY_CONNECTOR_SECRET ?? "";
    if (!secret) {
      return json({ ok: false as const, error: "Automatic connect is not available right now — paste your keys below instead." });
    }
    const dashboard = (process.env.SENTIENT_DASHBOARD_URL ?? "https://sentient-ui.com").replace(/\/$/, "");
    return redirect(`${dashboard}/connect/shopify?state=${encodeURIComponent(signConnectState(session.shop, secret))}`, { target: "_top" });
  }
  if (intent === "connect-discard") {
    // Only the offer the banner showed (review R4 L2): a newer one that landed
    // since stays, unrevoked.
    const shownAt = String(form.get("pendingCreatedAt") ?? "");
    await deletePendingConnect(session.shop, { revoke: true, ...(shownAt ? { createdAt: new Date(shownAt) } : {}) });
    return json({ ok: true as const, provisioned: false, pixelOk: false, mappingOk: false, error: null, discarded: true });
  }

  let publishableKey = String(form.get("publishableKey") ?? "").trim();
  let secretKey = String(form.get("secretKey") ?? "").trim();
  const mappingText = String(form.get("mappingText") ?? "");
  let pendingConfirmed = false;
  // Read before the confirm overwrites them: what this save replaces.
  const stored = await getSettings(session.shop);
  // Validated BEFORE a confirm stores anything: an invalid mapping in the
  // textarea used to make the confirm commit the keys, then fail on the
  // mapping — live keys, nothing provisioned, reported as a failed connect
  // (review R5 M3).
  const parsedMapping = parseTagMapping(mappingText);
  if (!parsedMapping.ok) {
    return json({ ok: false as const, error: `Audience mapping: ${parsedMapping.error}` });
  }
  if (intent === "connect-confirm") {
    // The merchant, signed in to THIS shop's admin, accepts the connection
    // the dashboard delivered; only now do the keys take effect. Bound to
    // exactly what the banner showed, and applied atomically with any
    // delivery racing it (review R2 H4, R4 N7).
    const confirmed = await confirmPendingConnect(session.shop, {
      projectId: String(form.get("pendingProjectId") ?? ""),
      createdAt: String(form.get("pendingCreatedAt") ?? ""),
    });
    if (!confirmed) {
      return json({ ok: false as const, error: "The connection request changed or expired since this page loaded — review it again before confirming." });
    }
    publishableKey = confirmed.publishableKey;
    secretKey = confirmed.secretKey;
    pendingConfirmed = true;
  }

  if (!publishableKey.startsWith("pk_")) {
    return json({ ok: false as const, error: "The publishable key should start with pk_." });
  }
  // The sk_ is never echoed back, so an empty field on a re-save means "keep
  // the stored one" — otherwise every settings tweak would demand a re-paste.
  const effectiveSecret = secretKey || stored?.secretKey || "";
  if (!effectiveSecret.startsWith("sk_")) {
    return json({ ok: false as const, error: "The secret key should start with sk_." });
  }
  // The storefront may be browsed on the myshopify domain OR the shop's custom
  // primary domain; the snippet's ingest Origin check needs whichever the
  // visitor uses, so provision allowlists both. Primary-domain read is
  // best-effort — worst case only the myshopify origin is registered.
  const [primaryDomain, observed] = await Promise.all([
    readPrimaryDomain(admin.graphql, session.shop),
    observeSubscription(admin.graphql),
  ]);
  // Provisioned BEFORE the keys are saved: a pasted key whose project this
  // store was disconnected from (or moved away from) was saved anyway, and
  // the store's plan events then followed an account it was no longer live
  // on — a cancellation never reached the account that kept the plan
  // (review R9 H1). Such a key is refused and the stored keys stay.
  const prov = await provisionSentient(effectiveSecret, {
    shopDomain: session.shop,
    primaryDomain,
    ...(observed.observed ? { subscriptionObserved: observed.observed } : {}),
  });
  const newPastedKey = !pendingConfirmed && effectiveSecret !== stored?.secretKey;
  if (newPastedKey && (prov.binding === "disconnected" || prov.binding === "detached")) {
    return json({
      ok: false as const,
      error:
        "This store was disconnected from that SentientUI project, so these keys can no longer connect it. Use \"Connect with SentientUI\" below, or keys created after the disconnect.",
    });
  }
  // REPLACING stored keys needs the API to confirm the store is live on the
  // new key's project: a timed-out provision, or an answer without a binding,
  // saved the old account's key anyway and the store's events followed an
  // account it was no longer live on (review R10-E). A first install stays
  // fail-soft (nothing to protect yet), and so does an app without the
  // connector secret (the API reports no binding to it).
  if (newPastedKey && stored?.secretKey && process.env.SHOPIFY_CONNECTOR_SECRET && !(prov.ok && prov.binding === "live")) {
    return json({
      ok: false as const,
      error: "SentientUI could not confirm these keys for this store just now, so your current keys were kept. Try saving again in a moment.",
    });
  }
  // A confirm already stored the keys, atomically (confirmPendingConnect).
  if (!pendingConfirmed) await saveSettings(session.shop, publishableKey, effectiveSecret);
  const provisioned = prov.ok;
  if (provisioned) await reconcilePlan(effectiveSecret, session.shop, observed);
  // Activate/refresh the app's web pixel with the current key (fast browser
  // path + upstream funnel steps), and persist the tag → persona mapping to
  // the app-data metafields the theme embed reads (mapping + pk_). Both fail-soft.
  const pixel = await ensureWebPixel(admin.graphql, publishableKey);
  const pixelOk = pixel.ok;
  // The same metafield write carries the pk_ the theme embed falls back to,
  // so the embed needs no second paste (audit H10).
  const mappingOk = await savePersonaTagMapping(admin.graphql, parsedMapping.mapping, publishableKey);

  // The keys this save replaced — a confirm or a paste — are revoked if they
  // were a zero-key pair (the API leaves pasted keys alone), and only once the
  // storefront has the new key: revoking first left a failed metafield write
  // with the embed on a dead pk_ (review R3).
  if (stored?.secretKey && stored.secretKey !== effectiveSecret && pixelOk && mappingOk) {
    // keepPk: a merchant who pasted only a new sk_ still serves the old
    // pair's pk_ to the storefront (review R4 H2).
    await revokeConnectPair(stored.secretKey, { keepPk: stored.publishableKey === publishableKey });
  }
  // Older connect pairs for this shop a failed save once skipped are swept
  // now (review R4 L1).
  if (pixelOk && mappingOk) await revokeConnectPair(effectiveSecret, { sweepOlder: true });

  const warnings = [
    provisioned ? null : "reaching SentientUI to set up the purchase goal failed — check the secret key and save again",
    pixelOk ? null : `activating the checkout pixel failed (${pixel.reason ?? 'unknown'}) — funnel steps won't be tracked until a later save succeeds`,
    // The same write carries the pk_ the theme embed falls back to, so a
    // failure here can mean no snippet at all on a blank embed (review R1 L3).
    mappingOk ? null : "saving the storefront settings (audience mapping and the key the theme embed reads) failed — try saving again",
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
          {data.results && (
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Results
                  </Text>
                  <Banner tone={data.results.tone} title={data.results.headline}>
                    <Text as="p" variant="bodyMd">{data.results.detail}</Text>
                  </Banner>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Measured against visitors who always see your original store (the control group). As of{" "}
                    {data.results.computedAt}.{" "}
                    <Link url={`${data.dashboardUrl}/projects/${data.results.projectId}`} target="_blank">
                      Open in SentientUI
                    </Link>
                  </Text>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}
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
                {data.storeDisconnected && (
                  <Banner tone="critical" title="This store is disconnected from SentientUI">
                    <Text as="p" variant="bodyMd">
                      It was disconnected from its SentientUI project (or connected to another one
                      since), so it no longer counts toward that account and a plan bought here will
                      not be applied. To use SentientUI
                      again, connect it below with &ldquo;Connect with SentientUI&rdquo;. If you
                      pay for a plan through Shopify, cancel it in your Shopify admin&rsquo;s app
                      settings.
                    </Text>
                  </Banner>
                )}
                {data.planIssue && (
                  <Banner tone="critical" title="A Shopify plan change was not applied">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd">
                        {data.planIssue.reason} ({data.planIssue.at})
                      </Text>
                      <Text as="p" tone="subdued" variant="bodySm">
                        Shopify may still bill you for it — cancel or change the plan in your
                        Shopify admin&rsquo;s app settings, or contact SentientUI support.
                      </Text>
                    </BlockStack>
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
                {/* Storefront reachability, stated out loud. Every
                    session/decision/event call from an unallowed origin 403s,
                    and the merchant's only symptom was a dashboard that never
                    filled up — the App Store rejected the app over exactly
                    that (5.1.2, round 3). A pass is worth showing too: it is
                    what tells a reviewer the integration works. */}
                {data.storefrontCheck?.ok === false && (
                  <Banner tone="critical" title="Your storefront can't reach SentientUI">
                    <Text as="p" variant="bodyMd">
                      {data.storefrontCheck.reason === "origin_not_allowed"
                        ? `${data.shop} isn't on your project's allowed domains yet, so every request from your storefront is refused. Press "Save and connect" below to add it.`
                        : data.storefrontCheck.reason === "invalid_key"
                          ? "The saved key was not recognised — it may have been disconnected or rotated in SentientUI. Press Connect with SentientUI again (or paste a current key) and save."
                          : "SentientUI could not be reached just now. This is usually temporary — reload this page in a minute."}
                    </Text>
                  </Banner>
                )}
                {data.storefrontCheck?.ok === true && (
                  <Banner tone="success" title="Your storefront is connected">
                    <Text as="p" variant="bodyMd">
                      Requests from {data.shop} are being accepted. Make sure the theme embed
                      carries this same publishable key.
                    </Text>
                  </Banner>
                )}
                {result && "error" in result && result.error && (
                  <Banner tone={result.ok ? "warning" : "critical"}>{result.error}</Banner>
                )}
                {result?.ok && !result.error && !("discarded" in result) && (
                  <Banner tone="success">
                    Connected. Purchase goal, checkout funnel, checkout pixel, and audience mapping are all set.
                  </Banner>
                )}
                {data.pendingConnect && !(result && "discarded" in result) && (
                  <Banner tone="info" title={`Connect this store to “${data.pendingConnect.projectName}”?`}>
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd">
                        Project ID <code>{data.pendingConnect.projectId}</code>. Confirm only if you just picked this
                        project in the SentientUI dashboard yourself — nothing changes on your store until you do.
                      </Text>
                      <InlineStack gap="200">
                        <Form method="post">
                          <input type="hidden" name="intent" value="connect-confirm" />
                          <input type="hidden" name="pendingProjectId" value={data.pendingConnect.projectId} />
                          <input type="hidden" name="pendingCreatedAt" value={data.pendingConnect.createdAt} />
                          <input type="hidden" name="mappingText" value={mappingText} />
                          <Button submit variant="primary" loading={saving}>Confirm and connect</Button>
                        </Form>
                        <Form method="post">
                          <input type="hidden" name="intent" value="connect-discard" />
                          <input type="hidden" name="pendingCreatedAt" value={data.pendingConnect.createdAt} />
                          <Button submit>Discard</Button>
                        </Form>
                      </InlineStack>
                    </BlockStack>
                  </Banner>
                )}
                <Form method="post">
                  <input type="hidden" name="intent" value="connect-start" />
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">
                      Sign in to SentientUI, pick or create a project, and come back here to confirm — no keys to copy.
                    </Text>
                    <InlineStack>
                      <Button submit variant="primary">Connect with SentientUI</Button>
                    </InlineStack>
                  </BlockStack>
                </Form>
                <Text as="p" variant="bodyMd">
                  Or paste a project&apos;s keys from the{" "}
                  <Link url="https://sentient-ui.com" target="_blank">
                    SentientUI dashboard
                  </Link>{" "}
                  (Settings → API keys):
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
                  <List.Item>Connect with SentientUI above (or paste your keys and save).</List.Item>
                  <List.Item>
                    <Link
                      url={`https://${data.shop}/admin/themes/current/editor?context=apps`}
                      target="_blank"
                    >
                      Enable the SentientUI embed
                    </Link>{" "}
                    in your theme (App embeds → SentientUI) and save the theme. The key is filled in from the one you saved above
                    — if you typed a key into the embed's own field earlier, clear it there: that field overrides this one.
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

            {/* Billing went through three review rejections before landing
                here: round 1 (2026-09-06) killed wording that framed the
                service as paid-and-required with an external billing link;
                round 2 (2026-09-09, ref 133916) ruled that even the optional
                subscription must go through Shopify; round 3 (2026-09-21)
                found this very link 404ing. So: plans are Shopify App
                Pricing, bought on Shopify's hosted plan page, and the only
                billing link in the app points THERE — never to an external
                payment page.

                The link 404s unless App Pricing is ENABLED in the Partner
                dashboard — drafting the plans is not enough, and that is
                exactly how round 3 happened. The `sentientui-app` segment is
                the app handle and is correct; it was wrongly suspected once,
                so do not "fix" it. Verified live 2026-09-22. */}
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Your plan
                </Text>
                <Text as="p" variant="bodySm">
                  The app is free to install, and everything it sets up works on the Free plan —
                  orders, refunds, the checkout funnel, audiences. If your store outgrows the
                  free tier&apos;s traffic or you want more seats and AI features,{" "}
                  <Link
                    url={`https://admin.shopify.com/store/${data.shop.replace('.myshopify.com', '')}/charges/sentientui-app/pricing_plans`}
                    target="_blank"
                  >
                    upgrade through Shopify
                  </Link>
                  {" "}— billed on your Shopify invoice, cancel anytime.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
