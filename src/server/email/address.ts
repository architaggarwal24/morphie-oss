/**
 * What counts as an email address here: a plain `local@domain.tld`, letters (any script), digits and the usual
 * address punctuation only. Quotes, angle brackets, parentheses, commas, semicolons, colons, backslashes and spaces are
 * refused: they are legal in RFC 5322 display forms, but they are exactly what mail libraries' address parsers have
 * mis-split into extra recipients (GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h in nodemailer).
 */
const LOCAL = /^[\p{L}\p{N}._%+\-!#$&'*/=?^`{|}~]{1,64}$/u;
const LABEL = /^(?!-)[\p{L}\p{N}-]{1,63}(?<!-)$/u;

export function isPlausibleEmail(e: string): boolean {
  if (e.length > 254) return false;
  const at = e.lastIndexOf("@");
  if (at <= 0 || e.indexOf("@") !== at) return false;
  const local = e.slice(0, at), domain = e.slice(at + 1);
  if (!LOCAL.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || domain.length > 190 || !labels.every((l) => LABEL.test(l))) return false;
  return /^[\p{L}]{2,63}$/u.test(labels[labels.length - 1]) || /^xn--[a-z0-9-]{1,59}$/i.test(labels[labels.length - 1]);
}
