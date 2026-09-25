import type { ActionFunctionArgs } from "@remix-run/node";
import { timingSafeEqual } from "node:crypto";
import db from "../db.server";
import { verifyConnectState } from "../lib/connect-state.server";
import { savePendingConnect } from "../lib/settings.server";

// Zero-key connect, server-to-server leg (audit H11): the SentientUI API
// delivers a freshly minted key pair for the project the merchant picked in
// the dashboard. Authorized by the connector secret; the state proves the
// flow began in this shop's admin (the app signed it). The keys are only
// HELD — the merchant confirms in their own admin before anything changes —
// because the state crossed a browser and a leaked link must never be able to
// point this store at someone else's project unseen.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const secret = process.env.SHOPIFY_CONNECTOR_SECRET ?? "";
  const presented = Buffer.from(request.headers.get("x-connector-secret") ?? "");
  const expected = Buffer.from(secret);
  if (secret === "" || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return Response.json({ error: "not_authorized" }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const state = verifyConnectState(body.state, secret);
  if (!state) return Response.json({ error: "invalid_state" }, { status: 400 });
  const publishableKey = typeof body.publishableKey === "string" ? body.publishableKey : "";
  const secretKey = typeof body.secretKey === "string" ? body.secretKey : "";
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  const projectName = typeof body.projectName === "string" ? body.projectName.slice(0, 200) : "";
  if (!publishableKey.startsWith("pk_") || !secretKey.startsWith("sk_") || projectId === "") {
    return Response.json({ error: "invalid_keys" }, { status: 400 });
  }
  // Only an installed shop: an uninstalled one has no admin to confirm in.
  const installed = await db.session.findFirst({ where: { shop: state.shop }, select: { id: true } });
  if (!installed) return Response.json({ error: "not_installed" }, { status: 404 });

  await savePendingConnect(state.shop, { publishableKey, secretKey, projectId, projectName });
  const apiKey = process.env.SHOPIFY_API_KEY ?? "";
  return Response.json({
    ok: true,
    // Where the dashboard sends the merchant to confirm: the app, inside this
    // shop's admin.
    returnUrl: apiKey ? `https://${state.shop}/admin/apps/${apiKey}` : `https://${state.shop}/admin/apps`,
  });
};
