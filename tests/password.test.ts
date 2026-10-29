import nodeCrypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as account from "@/app/api/account/route";
import * as accountPassword from "@/app/api/account/password/route";
import * as accountSession from "@/app/api/account/sessions/[id]/route";
import * as bootstrap from "@/app/api/bootstrap/route";
import * as emailRequest from "@/app/api/auth/email/request/route";
import * as emailVerify from "@/app/api/auth/email/verify/route";
import * as pwLogin from "@/app/api/auth/password/login/route";
import * as pwSignup from "@/app/api/auth/password/signup/route";
import { loginWithProvider } from "@/server/auth/accounts";
import { _setBreachLookupForTests } from "@/server/auth/breached";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { sqliteConn as db } from "@/server/db";
import { MemoryTransport, _resetTransportForTests, transport } from "@/server/email";
import { _resetRateLimits } from "@/server/security";
import { Client } from "./helpers/client";

beforeEach(async () => _resetRateLimits());
const addr = () => `pw-${Math.random().toString(36).slice(2, 9)}@example.com`;
const PASS = "correct horse battery";
const signUp = (c: Client, email: string, password = PASS, name?: string) => c.json(pwSignup.POST, "/api/auth/password/signup", { method: "POST", body: { email, password, name } });
const logIn = (c: Client, email: string, password = PASS) => c.json(pwLogin.POST, "/api/auth/password/login", { method: "POST", body: { email, password } });
const me = async (c: Client) => (await c.json(bootstrap.GET, "/api/bootstrap")).data.session;

describe("password hashing", () => {
  it("is salted scrypt, verifies the right password only, and never stores the password", async () => {
    const a = hashPassword(PASS), b = hashPassword(PASS);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[\w-]{43}\$[\w-]{43}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(PASS);
    expect(verifyPassword(PASS, a)).toBe(true);
    expect(verifyPassword("correct horse battery!", a)).toBe(false);
  });
});

describe("email + password accounts", () => {
  it("sign up signs you in, and you can log in again later", async () => {
    const email = addr();
    const c = new Client();
    const r = await signUp(c, email, PASS, "Ada");
    expect(r.status).toBe(200);
    expect((await me(c)).user).toMatchObject({ email, displayName: "Ada" });
    const row = db().prepare("SELECT password_hash, email_verified_at FROM users WHERE email = ?").get(email) as { password_hash: string; email_verified_at: number | null };
    expect(row.password_hash.startsWith("scrypt$")).toBe(true);
    expect(row.email_verified_at).toBeNull();                         // nobody proved this address

    const again = new Client();
    expect((await logIn(again, email)).status).toBe(200);
    expect((await me(again)).user.email).toBe(email);
  });

  it("weak passwords and bad addresses are refused with a reason; a taken address says to log in", async () => {
    const c = new Client();
    expect((await signUp(c, addr(), "short")).data.error).toMatch(/at least 10/);
    expect((await signUp(c, "not-an-email", PASS)).data.code).toBe("invalid_email");
    const email = addr();
    await signUp(new Client(), email);
    const taken = await signUp(new Client(), email);
    expect(taken.status).toBe(409);
    expect(taken.data.error).toMatch(/Log in instead/);
    expect(db().prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get(email).n).toBe(1);
  });

  it("refuses passwords from known breaches, sending only a 5-character hash prefix", async () => {
    const sent: string[] = [];
    // "correct horse battery" is breached in this fake; SHA-1 prefix and suffix computed the same way HIBP does.
    const sha1 = (p: string) => nodeCrypto.createHash("sha1").update(p).digest("hex").toUpperCase();
    const bad = "password123456";
    _setBreachLookupForTests(async (prefix) => { sent.push(prefix); return `${sha1(bad).slice(5)}:3861493\r\n0000000000000000000000000000000000A:0`; });
    try {
      const r = await signUp(new Client(), addr(), bad);
      expect(r.status).toBe(400);
      expect(r.data.error).toMatch(/data breach/);
      expect(sent).toEqual([sha1(bad).slice(0, 5)]);
      expect(sent.join("")).not.toContain(bad);
      expect((await signUp(new Client(), addr(), "a fine unbreached passphrase")).status).toBe(200);
      // Changing to a breached one is refused too.
      const email = addr(); const c = new Client(); await signUp(c, email);
      expect((await c.json(accountPassword.POST, "/api/account/password", { method: "POST", body: { current: PASS, next: bad } })).status).toBe(400);
      // The service being down never blocks a sign-up.
      vi.spyOn(console, "warn").mockImplementation(() => {});
      _setBreachLookupForTests(async () => { throw new Error("timeout"); });
      expect((await signUp(new Client(), addr(), bad)).status).toBe(200);
    } finally { _setBreachLookupForTests(null); }
  });
  it("a wrong password and an unknown address get the same answer, and neither signs in", async () => {
    const email = addr();
    await signUp(new Client(), email);
    const c = new Client();
    const wrong = await logIn(c, email, "wrong password here");
    const unknown = await logIn(c, addr());
    expect([wrong.status, unknown.status]).toEqual([400, 400]);
    expect(wrong.data).toEqual(unknown.data);
    expect(c.sessionToken).toBeUndefined();
  });

  it("guessing one account's password is capped per address, whatever the IP", async () => {
    const email = addr();
    await signUp(new Client(), email);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await logIn(new Client(), email, `guess-number-${i}`)).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("the limits hold across server instances (on Cloudflare each isolate has its own memory)", async () => {
    const email = addr();
    await signUp(new Client(), email);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      _resetRateLimits({ keepDurable: true }); // every attempt lands on a "fresh" instance
      statuses.push((await logIn(new Client(), email, "wrong password!!")).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    _resetRateLimits({ keepDurable: true });
    expect((await logIn(new Client(), email)).status).toBe(429); // even the right password waits
  });
  it("when the real owner later proves the address (Google), they take the account over: password gone, squatter signed out", async () => {
    const email = addr();
    const squatter = new Client();
    await signUp(squatter, email);
    const { user, created } = await loginWithProvider("google", { providerUserId: `g-${email}`, email });
    expect(created).toBe(false);
    expect(await me(squatter)).toBeNull();                                // their session ended
    expect((await logIn(new Client(), email)).status).toBe(400);           // their password no longer works
    const row = db().prepare("SELECT email_verified_at, password_hash FROM users WHERE id = ?").get(user.id) as { email_verified_at: number | null; password_hash: string | null };
    expect(row.email_verified_at).not.toBeNull();
    expect(row.password_hash).toBeNull();
  });

  it("the same takeover happens through an email code, and the response says the password was reset", async () => {
    _resetTransportForTests();
    const email = addr();
    await signUp(new Client(), email);
    const c = new Client();
    await c.json(emailRequest.POST, "/api/auth/email/request", { method: "POST", body: { email } });
    const code = /\b(\d{6})\b/.exec([...(transport() as MemoryTransport).outbox].reverse().find((m) => m.to === email)!.text)![1];
    const r = await c.json(emailVerify.POST, "/api/auth/email/verify", { method: "POST", body: { email, code } });
    expect(r.data).toMatchObject({ ok: true, created: false, passwordReset: true });
  });
});

describe("the Account API", () => {
  it("shows the profile, how you can log in and where you're signed in; renames you", async () => {
    const email = addr();
    const c = new Client();
    await signUp(c, email, PASS, "Ada");
    await logIn(new Client(), email);                                       // a second device
    const r = await c.json(account.GET, "/api/account");
    expect(r.data.account).toMatchObject({ email, displayName: "Ada", emailVerified: false, hasPassword: true, identities: [] });
    expect(r.data.sessions).toHaveLength(2);
    expect(r.data.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const renamed = await c.json(account.PATCH, "/api/account", { method: "PATCH", body: { displayName: "  Ada L.  " } });
    expect(renamed.data.account.displayName).toBe("Ada L.");
  });

  it("changing the password needs the current one and signs out your other sessions", async () => {
    const email = addr();
    const c = new Client(), other = new Client();
    await signUp(c, email);
    await logIn(other, email);
    expect((await c.json(accountPassword.POST, "/api/account/password", { method: "POST", body: { next: "a brand new passphrase" } })).status).toBe(400);
    expect((await c.json(accountPassword.POST, "/api/account/password", { method: "POST", body: { next: "a brand new passphrase", current: "wrong one entirely" } })).data.error).toMatch(/current password/);
    const ok = await c.json(accountPassword.POST, "/api/account/password", { method: "POST", body: { next: "a brand new passphrase", current: PASS } });
    expect(ok.data).toEqual({ ok: true, signedOutOthers: 1 });
    expect(await me(other)).toBeNull();
    expect(await me(c)).not.toBeNull();
    expect((await logIn(new Client(), email, "a brand new passphrase")).status).toBe(200);
  });

  it("an account without a password (email-code or Google) can set its first one", async () => {
    _resetTransportForTests();
    const email = addr();
    const c = new Client();
    await c.json(emailRequest.POST, "/api/auth/email/request", { method: "POST", body: { email } });
    const code = /\b(\d{6})\b/.exec([...(transport() as MemoryTransport).outbox].reverse().find((m) => m.to === email)!.text)![1];
    await c.json(emailVerify.POST, "/api/auth/email/verify", { method: "POST", body: { email, code } });
    expect((await c.json(account.GET, "/api/account")).data.account).toMatchObject({ hasPassword: false, emailVerified: true });
    expect((await c.json(accountPassword.POST, "/api/account/password", { method: "POST", body: { next: "first ever passphrase" } })).status).toBe(200);
    expect((await logIn(new Client(), email, "first ever passphrase")).status).toBe(200);
  });

  it("signs out one chosen session", async () => {
    const email = addr();
    const c = new Client(), phone = new Client();
    await signUp(c, email);
    await logIn(phone, email);
    const target = (await c.json(account.GET, "/api/account")).data.sessions.find((s: { current: boolean }) => !s.current).id;
    const r = await c.json(accountSession.DELETE, `/api/account/sessions/${target}`, { method: "DELETE", params: { id: target } });
    expect(r.data.sessions).toHaveLength(1);
    expect(await me(phone)).toBeNull();
  });

  it("deleting the account needs the exact email, then removes it and signs out", async () => {
    const email = addr();
    const c = new Client();
    await signUp(c, email);
    expect((await c.json(account.DELETE, "/api/account", { method: "DELETE", body: { confirmEmail: "someone@else.com" } })).status).toBe(400);
    expect((await c.json(account.DELETE, "/api/account", { method: "DELETE", body: { confirmEmail: email.toUpperCase() } })).status).toBe(200);
    expect(db().prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get(email).n).toBe(0);
    expect(c.sessionToken).toBeUndefined();
    expect((await signUp(new Client(), email)).status).toBe(200);          // the address is free again
  });
});

describe("development without a mail server", () => {
  it("hands the code to the popup when (and only when) the console transport is in use", async () => {
    const before = process.env.MORPHIE_EMAIL_TRANSPORT;
    try {
      process.env.MORPHIE_EMAIL_TRANSPORT = "console";
      _resetTransportForTests();
      const r = await new Client().json(emailRequest.POST, "/api/auth/email/request", { method: "POST", body: { email: addr() } });
      expect(r.data.delivery).toBe("console");
      expect(r.data.devCode).toMatch(/^\d{6}$/);
      process.env.MORPHIE_EMAIL_TRANSPORT = "memory";
      _resetTransportForTests();
      const real = await new Client().json(emailRequest.POST, "/api/auth/email/request", { method: "POST", body: { email: addr() } });
      expect(real.data.devCode).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.MORPHIE_EMAIL_TRANSPORT; else process.env.MORPHIE_EMAIL_TRANSPORT = before;
      _resetTransportForTests();
    }
  });
});
