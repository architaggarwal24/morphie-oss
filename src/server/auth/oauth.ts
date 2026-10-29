import { createHash, randomBytes } from "node:crypto";
import { config } from "../config";
import { decrypt, encrypt, randomToken, safeEqualHex, sha256 } from "../crypto";
import { db, now, stmt } from "../db";
import { guardedFetch } from "../net";
import type { Provider, VerifiedProfile } from "./accounts";

/**
 * Google and GitHub sign-in: the OAuth 2.0 authorization-code flow with PKCE (S256), a random `state` bound to the
 * browser by a cookie, the exact redirect URI from MORPHIE_PUBLIC_URL, and minimal scopes. Only verified emails are
 * accepted. Written against fetch with no OAuth library on purpose (the usual one is deprecated on npm and this flow
 * is small enough to audit in one sitting).
 */

export const STATE_TTL_MS = 10 * 60_000;
export const OAUTH_COOKIE = "morphie_oauth";
export const OAUTH_COOKIE_SECURE = "__Host-morphie_oauth";

export class OAuthError extends Error {
  constructor(public code: "state_mismatch" | "expired" | "denied" | "unverified_email" | "provider_error" | "identity_taken" | "link_session", message: string) { super(message); }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (u, i) => guardedFetch(u, i ?? {}, { allowPrivate: false });

export interface OAuthProvider {
  id: Provider;
  authorizationUrl(a: { state: string; challenge: string; redirectUri: string }): URL;
  /** Trade the code for an access token and read the (verified) profile. Throws OAuthError. */
  exchange(a: { code: string; verifier: string; redirectUri: string }): Promise<VerifiedProfile>;
}

export const pkceChallenge = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");
export const newVerifier = (): string => randomBytes(32).toString("base64url");

async function tokenRequest(f: FetchLike, url: string, client: { id: string; secret: string }, a: { code: string; verifier: string; redirectUri: string }): Promise<string> {
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: a.code, redirect_uri: a.redirectUri,
      client_id: client.id, client_secret: client.secret, code_verifier: a.verifier,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => { throw new OAuthError("provider_error", "Couldn't reach the sign-in provider."); });
  const data = (await res.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown };
  if (!res.ok || data.error || typeof data.access_token !== "string" || !data.access_token) throw new OAuthError("provider_error", "The sign-in provider rejected the request.");
  return data.access_token;
}

async function getJson(f: FetchLike, url: string, token: string, extra: Record<string, string> = {}): Promise<any> {
  const res = await f(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json", ...extra }, signal: AbortSignal.timeout(10_000) })
    .catch(() => { throw new OAuthError("provider_error", "Couldn't reach the sign-in provider."); });
  if (!res.ok) throw new OAuthError("provider_error", "The sign-in provider rejected the request.");
  return res.json().catch(() => { throw new OAuthError("provider_error", "The sign-in provider sent an unreadable answer."); });
}

export function googleProvider(client: { id: string; secret: string }, f: FetchLike = defaultFetch): OAuthProvider {
  return {
    id: "google",
    authorizationUrl({ state, challenge, redirectUri }) {
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.search = new URLSearchParams({
        response_type: "code", client_id: client.id, redirect_uri: redirectUri, scope: "openid email profile", state,
        code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
      }).toString();
      return u;
    },
    async exchange(a) {
      const token = await tokenRequest(f, "https://oauth2.googleapis.com/token", client, a);
      const me = await getJson(f, "https://openidconnect.googleapis.com/v1/userinfo", token);
      const verified = me.email_verified === true || me.email_verified === "true";
      if (typeof me.sub !== "string" || !me.sub) throw new OAuthError("provider_error", "The sign-in provider sent an unreadable answer.");
      if (typeof me.email !== "string" || !me.email || !verified) throw new OAuthError("unverified_email", "That Google account's email isn't verified.");
      return { providerUserId: me.sub, email: me.email, name: typeof me.name === "string" ? me.name : null };
    },
  };
}

export function githubProvider(client: { id: string; secret: string }, f: FetchLike = defaultFetch): OAuthProvider {
  const api = { "x-github-api-version": "2022-11-28", "user-agent": "morphie" };
  return {
    id: "github",
    authorizationUrl({ state, challenge, redirectUri }) {
      const u = new URL("https://github.com/login/oauth/authorize");
      u.search = new URLSearchParams({
        client_id: client.id, redirect_uri: redirectUri, scope: "user:email", state,
        code_challenge: challenge, code_challenge_method: "S256", allow_signup: "true",
      }).toString();
      return u;
    },
    async exchange(a) {
      const token = await tokenRequest(f, "https://github.com/login/oauth/access_token", client, a);
      const me = await getJson(f, "https://api.github.com/user", token, api);
      // The email on /user is whatever the person chose to show publicly: unverified and not trustworthy. Use /user/emails.
      const emails = await getJson(f, "https://api.github.com/user/emails", token, api);
      const primary = Array.isArray(emails) ? emails.find((e: any) => e?.primary === true && e?.verified === true && typeof e.email === "string") : undefined;
      if (me?.id == null) throw new OAuthError("provider_error", "The sign-in provider sent an unreadable answer.");
      if (!primary) throw new OAuthError("unverified_email", "That GitHub account has no verified primary email.");
      return { providerUserId: String(me.id), email: primary.email, name: typeof me.name === "string" && me.name ? me.name : typeof me.login === "string" ? me.login : null };
    },
  };
}

/** Providers that are configured. Tests may swap in fakes with setProviderOverrides. */
let overrides: Partial<Record<Provider, OAuthProvider>> | undefined;
export function setProviderOverrides(o?: Partial<Record<Provider, OAuthProvider>>): void { overrides = o; }

export function getProvider(id: string): OAuthProvider | null {
  if (id !== "google" && id !== "github") return null;
  if (overrides?.[id]) return overrides[id]!;
  const c = id === "google" ? config.googleClient : config.githubClient;
  if (!c) return null;
  return id === "google" ? googleProvider(c) : githubProvider(c);
}

export const oauthProviderEnabled = (id: Provider): boolean => getProvider(id) !== null;

/**
 * The exact redirect URI registered with the provider. In production it comes from MORPHIE_PUBLIC_URL only; the
 * request's Host header is never trusted for it. In development it falls back to the request's own origin.
 */
export function redirectUriFor(provider: Provider, req: Request): string {
  const base = config.publicUrl ?? (process.env.NODE_ENV === "production" ? undefined : new URL(req.url).origin);
  if (!base) throw new OAuthError("provider_error", "MORPHIE_PUBLIC_URL is not set.");
  return `${base}/api/auth/oauth/${provider}/callback`;
}

/** Only same-site relative paths survive; anything else (absolute URLs, //host, backslashes) becomes "/". */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw || raw.length > 200) return "/";
  return /^\/(?![/\\])[A-Za-z0-9\-._~/?=&%#:@+,]*$/.test(raw) ? raw : "/";
}

// ----------------------------------------------------------- state storage

/** `linkUserId`: this round trip connects the identity to that (signed-in) account instead of logging in. */
export async function beginLogin(provider: OAuthProvider, redirectUri: string, returnTo: string, at = now(), linkUserId: string | null = null): Promise<{ url: URL; state: string }> {
  const state = randomToken();
  const verifier = newVerifier();
  await db().batch([
    stmt("INSERT INTO oauth_states (state_hash, provider, verifier_enc, return_to, created_at, expires_at, link_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      sha256(state), provider.id, encrypt(verifier), returnTo, at, at + STATE_TTL_MS, linkUserId),
    stmt("DELETE FROM oauth_states WHERE expires_at < ?", at - 3_600_000), // tidy up
  ]);
  return { url: provider.authorizationUrl({ state, challenge: pkceChallenge(verifier), redirectUri }), state };
}

/**
 * Finish a login: the `state` in the URL must equal the one in this browser's cookie AND match an unused, unexpired
 * row for this provider, which is consumed atomically (a replayed callback fails).
 */
export async function completeLogin(
  provider: OAuthProvider, a: { code: string; stateParam: string | null; stateCookie: string | undefined; redirectUri: string }, at = now(),
): Promise<{ profile: VerifiedProfile; returnTo: string; linkUserId: string | null }> {
  if (!a.stateParam || !a.stateCookie || !safeEqualHex(sha256(a.stateParam), sha256(a.stateCookie))) throw new OAuthError("state_mismatch", "That sign-in didn't start in this browser.");
  const d = db();
  const row = await d.get<{ provider: string; verifier_enc: string; return_to: string; expires_at: number; link_user_id: string | null }>(
    "SELECT provider, verifier_enc, return_to, expires_at, link_user_id FROM oauth_states WHERE state_hash = ? AND used_at IS NULL", sha256(a.stateParam));
  if (!row || row.provider !== provider.id) throw new OAuthError("state_mismatch", "That sign-in isn't valid any more.");
  const won = await d.run("UPDATE oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?", at, sha256(a.stateParam), at);
  if (won.changes !== 1) throw new OAuthError(row.expires_at <= at ? "expired" : "state_mismatch", "That sign-in has expired. Please try again.");
  const profile = await provider.exchange({ code: a.code, verifier: decrypt(row.verifier_enc), redirectUri: a.redirectUri });
  return { profile, returnTo: safeReturnTo(row.return_to), linkUserId: row.link_user_id ?? null };
}
