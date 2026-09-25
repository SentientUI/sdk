import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// The connector secret also authenticates the app↔API calls as a bearer
// header; the state is signed with a key DERIVED from it so the one value
// never does two jobs (review R2 low).
const stateKey = (secret: string): Buffer => createHmac("sha256", secret).update("sentient-connect-state-v1").digest();

// Zero-key connect (audit H11): the state this shop's admin hands to the
// SentientUI dashboard. Mirrored byte for byte in
// apps/api/src/lib/shopify-connect-state.ts, which verifies it before minting
// keys. Ten minutes: the merchant signs in and picks a project, nothing more.
export type ConnectState = { shop: string; exp: number; n: string };

const TTL_MS = 10 * 60 * 1000;

export function signConnectState(shop: string, secret: string, now = Date.now()): string {
  const s: ConnectState = { shop, exp: now + TTL_MS, n: randomBytes(12).toString("base64url") };
  const payload = Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", stateKey(secret)).update(payload).digest("base64url")}`;
}

export function verifyConnectState(state: unknown, secret: string, now = Date.now()): ConnectState | null {
  if (typeof state !== "string" || secret === "") return null;
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  const payload = state.slice(0, dot);
  const sig = Buffer.from(state.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", stateKey(secret)).update(payload).digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<ConnectState>;
    if (typeof s.shop !== "string" || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s.shop)) return null;
    if (typeof s.exp !== "number" || s.exp < now) return null;
    if (typeof s.n !== "string") return null;
    return { shop: s.shop, exp: s.exp, n: s.n };
  } catch {
    return null;
  }
}
