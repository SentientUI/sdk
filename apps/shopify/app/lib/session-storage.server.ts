// At-rest encryption for Shopify session tokens (SHOP-9).
//
// Session.accessToken (and refreshToken, with expiring offline tokens on) sat
// in PLAINTEXT in the same database whose stored sk_ justified the secret-box
// envelope — a volume snapshot or a shell on the machine leaked Admin API
// access to every installed shop. PrismaSessionStorage owns the row I/O, so
// rather than fork it, this wraps it at the Session-object boundary: encrypt
// on the way in, decrypt on the way out. The delegate never notices.
//
// LAZY MIGRATION, same contract as secret-box.ts: rows written before this
// existed are plaintext and stay readable (decryptSecret returns anything
// without the "v1:" prefix unchanged — Shopify tokens start with shpat_/
// shpua_/…, never "v1:"), and the next storeSession re-writes them encrypted.
// No data migration, no flag day. When SETTINGS_ENCRYPTION_KEY is unset,
// encryptSecret degrades to plaintext — identical to today's behaviour, and
// the settings screen already warns about that state.
import { Session } from "@shopify/shopify-app-remix/server";
import { decryptSecret, encryptSecret } from "./secret-box";

/** Structural mirror of @shopify/shopify-app-session-storage's SessionStorage.
 *  Declared locally because that package is not a direct dependency (it rides
 *  in under the prisma storage adapter); TypeScript matches it structurally. */
export interface SessionStorageLike {
  storeSession(session: Session): Promise<boolean>;
  loadSession(id: string): Promise<Session | undefined>;
  deleteSession(id: string): Promise<boolean>;
  deleteSessions(ids: string[]): Promise<boolean>;
  findSessionsByShop(shop: string): Promise<Session[]>;
}

export class EncryptedSessionStorage implements SessionStorageLike {
  constructor(private readonly delegate: SessionStorageLike) {}

  async storeSession(session: Session): Promise<boolean> {
    // Clone before touching anything: the runtime keeps USING this session
    // object for the rest of the request (Admin API calls read .accessToken
    // off it), so encrypting in place would hand ciphertext to the next
    // GraphQL call and 401 every request that also stored.
    const clone = new Session(session.toObject());
    // The OAuth state session is stored BEFORE any token exists — leave
    // undefined/empty alone rather than encrypting "" into a real envelope.
    if (session.accessToken) clone.accessToken = encryptSecret(session.accessToken);
    if (session.refreshToken) clone.refreshToken = encryptSecret(session.refreshToken);
    return this.delegate.storeSession(clone);
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const session = await this.delegate.loadSession(id);
    if (!session) return undefined;
    return this.decryptOrDiscard(session);
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const sessions = await this.delegate.findSessionsByShop(shop);
    const out: Session[] = [];
    for (const s of sessions) {
      const dec = this.decryptOrDiscard(s);
      if (dec) out.push(dec);
    }
    return out;
  }

  deleteSession(id: string): Promise<boolean> {
    return this.delegate.deleteSession(id);
  }

  deleteSessions(ids: string[]): Promise<boolean> {
    return this.delegate.deleteSessions(ids);
  }

  /** Decrypts token fields in place (the session came from the delegate and
   *  is ours to mutate). A row that IS enveloped but will not decrypt means
   *  SETTINGS_ENCRYPTION_KEY was lost or rotated: returning it as-is would
   *  send ciphertext as a bearer token (confusing 401s far from the cause),
   *  and throwing would 500 every embedded request. Treat it as no session —
   *  the embedded token-exchange strategy mints a fresh one from the id token
   *  and the next store re-encrypts under the current key. Log the real cause
   *  so the operator sees WHY everyone silently re-authenticated. */
  private decryptOrDiscard(session: Session): Session | undefined {
    try {
      if (session.accessToken) session.accessToken = decryptSecret(session.accessToken);
      if (session.refreshToken) session.refreshToken = decryptSecret(session.refreshToken);
      return session;
    } catch (err) {
      console.error(
        `[sentient] cannot decrypt stored session ${session.id} for ${session.shop}: ` +
          `SETTINGS_ENCRYPTION_KEY is missing or was rotated — treating as logged out ` +
          `so auth re-runs. (${err instanceof Error ? err.message : String(err)})`,
      );
      return undefined;
    }
  }
}
