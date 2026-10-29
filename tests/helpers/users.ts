import { randomId } from "@/server/crypto";
import { sqliteConn as db } from "@/server/db";
import { newSession, type StartedSession } from "@/server/auth/session";
import { Client } from "./client";

/** Create an account directly in the database (accounts are the only kind of user there is). */
export function makeUser(email = `u-${randomId(4)}@example.com`): { userId: string; email: string } {
  const userId = randomId(18);
  const t = Date.now();
  db().prepare("INSERT INTO users (id, created_at, email, email_verified_at, display_name, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, t, email.toLowerCase(), t, "Test User", t);
  return { userId, email: email.toLowerCase() };
}

/** Give a client a live session for a user (as a login would). */
export function signIn(client: Client, userId: string): StartedSession {
  // Synchronous on purpose (tests call it from constructors and plain helpers): the same INSERT startSession runs.
  const { started: s, insert } = newSession(userId, { ip: "test" }, Date.now());
  db().prepare(insert.sql).run(...(insert.params as never[]));
  client.jar.set(client.origin.startsWith("https") ? "__Host-morphie_session" : "morphie_session", s.token);
  return s;
}

/** A browser that is signed in as a brand-new account. */
export function accountClient(origin?: string): Client {
  const c = new Client(origin);
  signIn(c, makeUser().userId);
  return c;
}
