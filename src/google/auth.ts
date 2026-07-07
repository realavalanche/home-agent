import { google } from "googleapis";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { logger } from "../logger.js";
import type { AuthorKey } from "../users.js";

/**
 * Per-user Google OAuth. Each of the two users consents once; we store their
 * refresh token and mint access tokens on demand. Two fully separate token sets
 * means calendar/gmail actions always happen as the right person.
 *
 * Scopes: Calendar only for now. Gmail's scopes are "restricted" and trigger a
 * heavy Google verification, so they're left out until wanted — re-add the two
 * gmail scopes here (and enable the Gmail API) to turn email back on.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  // "https://www.googleapis.com/auth/gmail.readonly",
  // "https://www.googleapis.com/auth/gmail.compose",
];

function requireGoogleConfig() {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !config.GOOGLE_REDIRECT_URI) {
    throw new Error("Google OAuth env not set (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI).");
  }
}

// Infer the OAuth2 client type from googleapis itself so it matches the copy of
// google-auth-library that google.calendar()/gmail() expect (avoids the
// duplicate-package private-field type clash).
type GoogleOAuthClient = InstanceType<typeof google.auth.OAuth2>;

function newOAuthClient(): GoogleOAuthClient {
  requireGoogleConfig();
  return new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    config.GOOGLE_REDIRECT_URI
  );
}

/** URL a user visits once to grant access. `state` carries their author key. */
export function consentUrl(authorKey: AuthorKey): string {
  return newOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force a refresh_token even on re-consent
    scope: GOOGLE_SCOPES,
    state: authorKey,
  });
}

/** Exchange the callback code and persist the user's refresh token. */
export async function handleCallback(code: string, authorKey: AuthorKey): Promise<void> {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "No refresh_token returned. Revoke prior access at myaccount.google.com and retry."
    );
  }
  await query(
    `INSERT INTO google_tokens (author_key, access_token, refresh_token, scope, expiry_date, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (author_key) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       scope = EXCLUDED.scope,
       expiry_date = EXCLUDED.expiry_date,
       updated_at = now()`,
    [authorKey, tokens.access_token ?? null, tokens.refresh_token, tokens.scope ?? null, tokens.expiry_date ?? null]
  );
  logger.info("google tokens stored", { authorKey });
}

/**
 * Get an authorized client for a user, or undefined if they haven't connected.
 * Persists refreshed access tokens as googleapis rotates them.
 */
export async function getAuthedClient(authorKey: AuthorKey): Promise<GoogleOAuthClient | undefined> {
  const res = await query<{
    access_token: string | null;
    refresh_token: string;
    expiry_date: string | null;
  }>(`SELECT access_token, refresh_token, expiry_date FROM google_tokens WHERE author_key = $1`, [
    authorKey,
  ]);
  const row = res.rows[0];
  if (!row) return undefined;

  const client = newOAuthClient();
  client.setCredentials({
    access_token: row.access_token ?? undefined,
    refresh_token: row.refresh_token,
    expiry_date: row.expiry_date ? Number(row.expiry_date) : undefined,
  });
  client.on("tokens", (tokens) => {
    void query(
      `UPDATE google_tokens SET access_token = COALESCE($2, access_token),
         expiry_date = COALESCE($3, expiry_date), updated_at = now()
       WHERE author_key = $1`,
      [authorKey, tokens.access_token ?? null, tokens.expiry_date ?? null]
    ).catch((err) => logger.warn("token persist failed", { err: String(err) }));
  });
  return client;
}

export async function isConnected(authorKey: AuthorKey): Promise<boolean> {
  const res = await query(`SELECT 1 FROM google_tokens WHERE author_key = $1`, [authorKey]);
  return res.rowCount === 1;
}
