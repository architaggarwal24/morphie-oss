import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

/** Reads a persistent random secret from the data dir, creating it (0600) on first use. Never in production. */
function fileSecret(name: string): Buffer {
  if (process.env.NODE_ENV === "production") {
    throw new Error("ENCRYPTION_KEY and SESSION_SECRET must be set in production; file-based secrets are for development only.");
  }
  const file = path.join(config.dataDir, name);
  try {
    const hex = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  } catch {
    /* create below */
  }
  const fresh = crypto.randomBytes(32);
  fs.writeFileSync(file, fresh.toString("hex"), { mode: 0o600 });
  return fresh;
}

let cachedEnc: Buffer | null = null;
let cachedSig: Buffer | null = null;

function encKey(): Buffer {
  if (cachedEnc) return cachedEnc;
  const env = config.encryptionKey;
  cachedEnc = env ? crypto.createHash("sha256").update(`morphie-enc:${env}`).digest() : fileSecret(".encryption_key");
  return cachedEnc;
}

function sigKey(): Buffer {
  if (cachedSig) return cachedSig;
  const env = config.sessionSecret;
  cachedSig = env ? crypto.createHash("sha256").update(`morphie-sig:${env}`).digest() : fileSecret(".session_secret");
  return cachedSig;
}

/** AES-256-GCM. Output: "v1." + base64url(iv | tag | ciphertext). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return "v1." + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
}

export function decrypt(token: string): string {
  if (!token.startsWith("v1.")) throw new Error("Unrecognised secret format");
  const raw = Buffer.from(token.slice(3), "base64url");
  if (raw.length < 29) throw new Error("Secret is corrupt");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

export function sign(value: string): string {
  return crypto.createHmac("sha256", sigKey()).update(value).digest("base64url").slice(0, 32);
}

export function verifySig(value: string, sig: string): boolean {
  const expected = Buffer.from(sign(value));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Derive a purpose-bound subkey from the encryption key (used for hashing one-time codes). */
export function subkey(label: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", encKey(), Buffer.alloc(0), `morphie:${label}`, 32));
}

export function hmacHex(label: string, data: string): string {
  return crypto.createHmac("sha256", subkey(label)).update(data).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8"); const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** 32 random bytes as base64url: the secret half of a session or OAuth state. */
export function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function randomId(bytes = 12): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(data: string | Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Test hook: forget cached keys. */
export function _resetCryptoCache(): void {
  cachedEnc = null;
  cachedSig = null;
}
