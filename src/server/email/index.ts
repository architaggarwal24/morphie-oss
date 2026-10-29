import { config } from "../config";
import { guardedFetch, onWorkers } from "../net";
import nodemailer from "nodemailer";
import { isPlausibleEmail } from "./address";

export interface EmailMessage { to: string; subject: string; text: string }

export interface EmailTransport {
  readonly name: string;
  send(msg: EmailMessage): Promise<void>;
}

/** Sends through any SMTP server (smtp://user:pass@host:587 or smtps://...). The URL contains a password: never log it. */
export class SmtpTransport implements EmailTransport {
  readonly name = "smtp";
  constructor(private mailer: { sendMail(o: Record<string, unknown>): Promise<unknown> }, private from: string) {}
  async send(m: EmailMessage): Promise<void> {
    if (!isPlausibleEmail(m.to)) throw new Error("Refusing to send to a malformed address.");
    await this.mailer.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text });
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Sends through the Resend HTTPS API. */
export class ResendTransport implements EmailTransport {
  readonly name = "resend";
  constructor(private apiKey: string, private from: string, private doFetch: FetchLike = (u, i) => guardedFetch(u, i, { allowPrivate: false })) {}
  async send(m: EmailMessage): Promise<void> {
    if (!isPlausibleEmail(m.to)) throw new Error("Refusing to send to a malformed address.");
    const res = await this.doFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, text: m.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend rejected the message (HTTP ${res.status}).`); // never echo the body: it can contain addresses
  }
}

/** Development only: prints the message (including the sign-in code) to the server console. */
export class ConsoleTransport implements EmailTransport {
  readonly name = "console";
  async send(m: EmailMessage): Promise<void> {
    console.info(`\n[email:dev] to=${m.to}\n[email:dev] subject=${m.subject}\n${m.text.split("\n").map((l) => `[email:dev]   ${l}`).join("\n")}\n`);
  }
}

/** Tests only: collects messages so tests can read the code that "was emailed". */
export class MemoryTransport implements EmailTransport {
  readonly name = "memory";
  readonly outbox: EmailMessage[] = [];
  async send(m: EmailMessage): Promise<void> { this.outbox.push(m); }
}

export type TransportName = "smtp" | "resend" | "console" | "memory";

/**
 * nodemailer waits up to two minutes for an unreachable or silent mail server, so a wrong host looks like "the code never
 * arrives" for that long. Fail in seconds instead. Anything already set in the URL is left alone.
 */
export function smtpUrlWithTimeouts(url: string): string {
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries({ connectionTimeout: "10000", greetingTimeout: "10000", socketTimeout: "20000" })) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
    return u.toString();
  } catch { return url; }
}

/**
 * Whether the last real send worked. This is about the SERVER (wrong password, unverified sender, host down), never about an
 * address, so showing it to a visitor reveals nothing about who has an account. Sends stay fire-and-forget (see otp.ts).
 */
// On globalThis like the other process-wide state (db, approvals): Next bundles each route separately, so a plain module variable
// written by the route that sends the code would be invisible to the route that reports on it.
const g = globalThis as unknown as { __morphieMailStatus?: { at: number; ok: boolean } };
const FAILURE_MEMORY_MS = 15 * 60_000;
export function noteSend(ok: boolean, at = Date.now()): void { g.__morphieMailStatus = { at, ok }; }
/** "console": nothing is emailed, the code is printed on the server (development only). "failing": the last send failed recently. */
export function deliveryStatus(at = Date.now()): "console" | "failing" | undefined {
  if (transportName() === "console") return "console";
  const last = g.__morphieMailStatus;
  return last && !last.ok && at - last.at < FAILURE_MEMORY_MS ? "failing" : undefined;
}
export function _resetDeliveryForTests(): void { g.__morphieMailStatus = undefined; }

/** What to check when a send fails, per transport (written to the server log, never shown to visitors). */
export function sendFailureHint(name: string): string {
  if (name === "smtp") return "Check MORPHIE_SMTP_URL, and that MORPHIE_EMAIL_FROM is an address your mail provider lets you send from.";
  if (name === "resend") return "Check RESEND_API_KEY, and that MORPHIE_EMAIL_FROM uses a domain verified in Resend.";
  return "";
}

/**
 * Which transport is configured, or undefined when email login is unavailable.
 * console and memory exist ONLY outside production: this is checked here, again in createTransport(), and at startup
 * in assertProductionConfig(), so there is no path that mails to a console in production.
 */
export function transportName(env: NodeJS.ProcessEnv = process.env): TransportName | undefined {
  const prod = env.NODE_ENV === "production";
  const configured = env.MORPHIE_EMAIL_TRANSPORT?.trim().toLowerCase();
  if (configured === "smtp") return env.MORPHIE_SMTP_URL?.trim() ? "smtp" : undefined;
  if (configured === "resend") return env.RESEND_API_KEY?.trim() ? "resend" : undefined;
  if (configured === "console") return prod ? undefined : "console";
  if (configured === "memory") return env.NODE_ENV === "test" ? "memory" : undefined;
  if (!configured && !prod) return env.NODE_ENV === "test" ? "memory" : "console"; // development default
  return undefined;
}

export const emailLoginEnabled = (): boolean => transportName() !== undefined;

let cached: { key: string; transport: EmailTransport } | undefined;

export function createTransport(env: NodeJS.ProcessEnv = process.env): EmailTransport {
  const name = transportName(env);
  if (!name) throw new Error("Email login is not configured.");
  if (env.NODE_ENV === "production" && (name === "console" || name === "memory")) throw new Error("The console email transport is not allowed in production.");
  const from = config.emailFrom;
  switch (name) {
    case "smtp":
      // SMTP needs raw TCP sockets, which Cloudflare Workers doesn't give nodemailer. Say so instead of failing per email.
      if (onWorkers()) throw new Error("SMTP isn't available on Cloudflare Workers. Set MORPHIE_EMAIL_TRANSPORT=resend and RESEND_API_KEY instead.");
      return new SmtpTransport(nodemailer.createTransport(smtpUrlWithTimeouts(env.MORPHIE_SMTP_URL!.trim())), from);
    case "resend": return new ResendTransport(env.RESEND_API_KEY!.trim(), from);
    case "console": return new ConsoleTransport();
    case "memory": return new MemoryTransport();
  }
}

/** The process-wide transport (memoised so the memory outbox persists). */
export function transport(): EmailTransport {
  const key = `${transportName()}|${process.env.NODE_ENV}`;
  if (!cached || cached.key !== key) cached = { key, transport: createTransport() };
  return cached.transport;
}

export function _resetTransportForTests(): void { cached = undefined; }
