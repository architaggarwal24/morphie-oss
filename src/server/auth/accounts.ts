import { randomId } from "../crypto";
import { db, isUniqueViolation, now, stmt } from "../db";

/**
 * Accounts come from a proven email (a one-time code, or a provider that vouches for it), or from email + password,
 * where nothing was proven (email_verified_at is NULL). "Same VERIFIED email" is the only linking rule:
 * when a proven login meets an account whose address was never proven, the proven owner takes it over. Its password
 * is cleared and all its sessions end (claimVerifiedEmail), so whoever typed that address first can't stay inside.
 */

export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

export interface AccountUser { id: string; email: string; displayName: string | null }
const toUser = (r: { id: string; email: string; display_name: string | null }): AccountUser => ({ id: r.id, email: r.email, displayName: r.display_name });

export async function findUserByEmail(email: string): Promise<AccountUser | null> {
  const r = await db().get<{ id: string; email: string; display_name: string | null }>("SELECT id, email, display_name FROM users WHERE email = ?", normalizeEmail(email));
  return r ? toUser(r) : null;
}

function displayNameFor(email: string, name?: string | null): string {
  return (name?.trim() || email.split("@")[0]).slice(0, 60);
}

/**
 * Someone just proved they own this address. If the account for it was made with a password nobody verified, the
 * proven owner takes it: the password goes, every existing session is signed out, and the address is marked verified.
 * Returns true when that happened (the UI tells them to set a new password in Account).
 */
export async function claimVerifiedEmail(userId: string, at = now()): Promise<boolean> {
  const d = db();
  const row = await d.get<{ email_verified_at: number | null; password_hash: string | null }>("SELECT email_verified_at, password_hash FROM users WHERE id = ?", userId);
  if (!row || row.email_verified_at != null) return false;
  // Guarded by "still unverified", so two simultaneous proofs do this once.
  const [won] = await d.batch([
    stmt("UPDATE users SET email_verified_at = ?, password_hash = NULL, password_updated_at = ? WHERE id = ? AND email_verified_at IS NULL", at, at, userId),
    stmt("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = ? AND email_verified_at = ?)", at, userId, userId, at),
  ]);
  return won.changes === 1 && !!row.password_hash;
}

/** Find the account for a verified email, creating it if this is the first time. Race-safe (unique index on email). */
export async function findOrCreateAccount(verifiedEmail: string, name?: string | null): Promise<{ user: AccountUser; created: boolean; passwordReset?: boolean }> {
  const email = normalizeEmail(verifiedEmail);
  const existing = await findUserByEmail(email);
  if (existing) return { user: existing, created: false, passwordReset: await claimVerifiedEmail(existing.id) };
  const id = randomId(18);
  const t = now();
  try {
    await db().run("INSERT INTO users (id, created_at, email, email_verified_at, display_name, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
      id, t, email, t, displayNameFor(email, name), t);
  } catch (e) {
    const again = await findUserByEmail(email); // someone else created it a moment ago
    if (again) return { user: again, created: false };
    throw e;
  }
  return { user: { id, email, displayName: displayNameFor(email, name) }, created: true };
}

export type Provider = "google" | "github";

export interface VerifiedProfile {
  providerUserId: string;
  /** Verified by the provider. Adapters throw rather than return an unverified address. */
  email: string;
  name?: string | null;
}

export interface OAuthLoginResult { user: AccountUser; created: boolean; linked: boolean }

/**
 * 1. A known (provider, provider user id) always wins: it is stable even if the person changes their email.
 * 2. Otherwise the same verified email maps to the same account (and the identity is linked to it).
 * 3. Otherwise a new account is created.
 */
export async function loginWithProvider(provider: Provider, profile: VerifiedProfile): Promise<OAuthLoginResult> {
  const d = db();
  const known = async () => d.get<{ id: string; email: string; display_name: string | null }>(
    "SELECT u.id, u.email, u.display_name FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.provider_user_id = ?",
    provider, profile.providerUserId);
  const idRow = await known();
  if (idRow) return { user: toUser(idRow), created: false, linked: false };

  const { user, created } = await findOrCreateAccount(profile.email, profile.name);
  // The identity's primary key makes a simultaneous second link a no-op; whoever linked first owns it.
  const info = await d.run("INSERT INTO user_identities (provider, provider_user_id, user_id, email, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    provider, profile.providerUserId, user.id, normalizeEmail(profile.email), now());
  if (info.changes === 0) {
    const winner = await known();
    if (winner) return { user: toUser(winner), created: false, linked: false };
  }
  if (!created && !user.displayName && profile.name) await d.run("UPDATE users SET display_name = ? WHERE id = ?", profile.name.slice(0, 60), user.id);
  return { user, created, linked: !created };
}

export async function identitiesOf(userId: string): Promise<Array<{ provider: string; email: string }>> {
  return db().all<{ provider: string; email: string }>("SELECT provider, email FROM user_identities WHERE user_id = ? ORDER BY created_at", userId);
}

/**
 * Connect a provider identity to an account that is already signed in (Account → Connect). The provider vouched for
 * its email, but it need not match the account's: the person proved they hold both by being signed in here and
 * completing the provider's consent in the same browser. An identity already linked to ANOTHER account is refused
 * (no silent moves); one already on this account is a no-op. One identity per provider per account.
 */
export async function linkIdentity(userId: string, provider: Provider, profile: VerifiedProfile): Promise<"linked" | "already"> {
  const d = db();
  const owner = await d.get<{ user_id: string }>("SELECT user_id FROM user_identities WHERE provider = ? AND provider_user_id = ?", provider, profile.providerUserId);
  if (owner) {
    if (owner.user_id === userId) return "already";
    throw Object.assign(new Error("That account is already connected to a different Morphie account."), { code: "identity_taken" as const });
  }
  try {
    await d.batch([
      stmt("DELETE FROM user_identities WHERE user_id = ? AND provider = ?", userId, provider), // replace an older one
      stmt("INSERT INTO user_identities (provider, provider_user_id, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)",
        provider, profile.providerUserId, userId, normalizeEmail(profile.email), now()),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw Object.assign(new Error("That account is already connected to a different Morphie account."), { code: "identity_taken" as const });
    throw e;
  }
  return "linked";
}

/** Disconnect a provider from this account. Returns false when it wasn't connected. The caller checks lock-out. */
export async function unlinkIdentity(userId: string, provider: Provider): Promise<boolean> {
  return (await db().run("DELETE FROM user_identities WHERE user_id = ? AND provider = ?", userId, provider)).changes > 0;
}
