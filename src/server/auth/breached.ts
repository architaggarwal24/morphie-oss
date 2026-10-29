import crypto from "node:crypto";
import { guardedFetch } from "../net";

/**
 * Has this password shown up in a data breach? Asks Have I Been Pwned's range API with k-anonymity: only the first
 * five characters of the password's SHA-1 leave the server, and the answer is every suffix sharing them (padded, so
 * its size says nothing either). Credential-stuffing lists are made of exactly these passwords.
 *
 * Fails open: if the service is slow or down, the password is judged on the other rules alone (a sign-up must not
 * depend on a third party being up). Off with MORPHIE_BREACHED_PASSWORD_CHECK=off. Tests swap the lookup.
 */
type RangeLookup = (prefix: string) => Promise<string>;

const hibp: RangeLookup = async (prefix) => {
  const res = await guardedFetch(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { "add-padding": "true", "user-agent": "Morphie" }, signal: AbortSignal.timeout(2500) }, { allowPrivate: false });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

let lookup: RangeLookup | null = null;
/** Tests: answer range queries locally (null = the real service). */
export function _setBreachLookupForTests(fn: RangeLookup | null): void { lookup = fn; }

export async function timesBreached(password: string): Promise<number> {
  const setting = process.env.MORPHIE_BREACHED_PASSWORD_CHECK?.trim().toLowerCase();
  if (setting && ["0", "false", "no", "off"].includes(setting)) return 0;
  // Tests never reach the network: only a lookup a test installed is used.
  const ask = lookup ?? (process.env.NODE_ENV === "test" ? null : hibp);
  if (!ask) return 0;
  const sha1 = crypto.createHash("sha1").update(password.normalize("NFKC")).digest("hex").toUpperCase();
  try {
    const body = await ask(sha1.slice(0, 5));
    for (const line of body.split("\n")) {
      const [suffix, count] = line.trim().split(":");
      if (suffix === sha1.slice(5)) return Number(count) || 0; // padding entries have a count of 0
    }
    return 0;
  } catch (e) {
    console.warn(`[auth] couldn't check the password against known breaches (${(e as Error).message}); judged on the other rules.`);
    return 0;
  }
}

export const BREACHED_MESSAGE = "That password has appeared in a data breach, so attackers try it first. Pick a different one.";
