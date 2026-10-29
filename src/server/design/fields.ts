/**
 * Field combinators for the strict design schema. Model output is untrusted input: every
 * value is projected onto an allowlist, type/length-checked, and all problems are collected
 * so the agent can hand the model one complete list of what to fix. Idempotent by design.
 */
import { MAX_WIDTH_RANGE } from "./layouts";
import { FONT_NAMES, normalizeHex } from "./themes";

export const MISSING = Symbol("missing");
export const INVALID = Symbol("invalid");
export type Cleaned = unknown;

export class DesignValidationError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    const list = errors.length ? [...errors] : ["The design is invalid."];
    super(list.join("; "));
    this.errors = list;
  }
}

export class ValidationState {
  errors: string[] = [];
  constructor(public notes: string[] = []) {}
  error(path: string, message: string) { this.errors.push(path ? `${path}: ${message}` : message); }
  note(path: string, message: string) { this.notes.push(path ? `${path}: ${message}` : message); }
}

/** A short, safe rendering of a value for error messages (never recurses into containers). */
export function shortRepr(v: unknown): string {
  if (v === null || v === undefined || typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") { const t = JSON.stringify(v); return t.length <= 40 ? t : t.slice(0, 37) + "..."; }
  return Array.isArray(v) ? "<list>" : typeof v === "object" ? "<object>" : `<${typeof v}>`;
}

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const typeName = (v: unknown) => (Array.isArray(v) ? "list" : v === null ? "null" : typeof v);

export abstract class Field {
  default: unknown;
  optional: boolean;
  constructor(opts: { optional?: boolean; default?: unknown } = {}) {
    this.default = "default" in opts ? opts.default : MISSING;
    this.optional = !!opts.optional || this.default !== MISSING;
  }
  protected absent(v: unknown): boolean { return v === null || v === undefined; }
  protected whenAbsent(path: string, st: ValidationState): Cleaned {
    if (this.default !== MISSING) return Array.isArray(this.default) ? [...this.default] : this.default;
    if (this.optional) return MISSING;
    st.error(path, "is required");
    return INVALID;
  }
  clean(value: unknown, path: string, st: ValidationState): Cleaned {
    return this.absent(value) ? this.whenAbsent(path, st) : this.cleanPresent(value, path, st);
  }
  protected abstract cleanPresent(value: unknown, path: string, st: ValidationState): Cleaned;
  abstract describe(): string;
  protected suffix(): string {
    if (this.default !== MISSING && !(Array.isArray(this.default) && !this.default.length)) return ` (default ${JSON.stringify(this.default)})`;
    return this.optional ? " (optional)" : "";
  }
}

export class Str extends Field {
  constructor(public maxLen: number, opts: { optional?: boolean; default?: unknown } = {}) { super(opts); }
  protected absent(v: unknown) { return v == null || (typeof v === "string" && !v.trim()); }
  protected cleanPresent(value: unknown, path: string, st: ValidationState) {
    if (typeof value === "boolean" || !["string", "number"].includes(typeof value)) { st.error(path, `must be text, not ${typeName(value)}`); return INVALID; }
    const text = String(value).replace(CONTROL, "").replace(/\s+/g, " ").trim();
    if (text.length > this.maxLen) { st.error(path, `is too long (${text.length} > ${this.maxLen} characters)`); return INVALID; }
    return text;
  }
  describe() { return `text ≤${this.maxLen}${this.suffix()}`; }
}

export class Enum extends Field {
  options: string[];
  constructor(options: readonly (string | number)[], opts: { default?: unknown; fallback?: string } = {}) {
    super(opts.default !== undefined ? { default: opts.default } : {});
    this.options = options.map(String);
    this.fallback = opts.fallback;
  }
  fallback?: string;
  protected cleanPresent(value: unknown, path: string, st: ValidationState) {
    const c = typeof value === "string" ? value.trim().toLowerCase() : null;
    if (c !== null && this.options.includes(c)) return c;
    if (this.fallback !== undefined) { st.note(path, `unknown value ${shortRepr(value)} replaced with '${this.fallback}'`); return this.fallback; }
    st.error(path, `must be one of ${this.options.join(", ")} (got ${shortRepr(value)})`);
    return INVALID;
  }
  describe() { return this.options.join(" | ") + this.suffix(); }
}

export class Int extends Field {
  constructor(public lo: number, public hi: number, opts: { default?: unknown } = {}) { super(opts.default !== undefined ? { default: opts.default } : {}); }
  protected cleanPresent(value: unknown, path: string, st: ValidationState) {
    let n: number | null = null;
    if (typeof value === "number" && Number.isInteger(value)) n = value;
    else if (typeof value === "string" && /^\d{1,6}$/.test(value.trim())) n = parseInt(value.trim(), 10);
    if (n === null || n < this.lo || n > this.hi) { st.error(path, `must be a whole number from ${this.lo} to ${this.hi} (got ${shortRepr(value)})`); return INVALID; }
    return n;
  }
  describe() { return `integer ${this.lo}-${this.hi}${this.suffix()}`; }
}

export class Bool extends Field {
  constructor(opts: { default?: boolean } = {}) { super({ default: opts.default ?? false }); }
  protected cleanPresent(value: unknown, path: string, st: ValidationState) {
    if (typeof value === "boolean") return value;
    st.error(path, `must be true or false (got ${shortRepr(value)})`);
    return INVALID;
  }
  describe() { return `true | false (default ${this.default})`; }
}

export class Hex extends Field {
  protected cleanPresent(value: unknown, path: string, st: ValidationState) {
    const c = normalizeHex(value);
    if (!c) { st.error(path, `must be a hex color like #1a2b3c (got ${shortRepr(value)})`); return INVALID; }
    return c;
  }
  describe() { return "#rrggbb" + this.suffix(); }
}

export class Font extends Field {
  protected cleanPresent(value: unknown, path: string, st: ValidationState) {
    if (typeof value === "string") {
      const w = value.trim().toLowerCase();
      const hit = FONT_NAMES.find((f) => f.toLowerCase() === w);
      if (hit) return hit;
    }
    st.error(path, `must be one of the supported fonts (${FONT_NAMES.join(", ")}) (got ${shortRepr(value)})`);
    return INVALID;
  }
  describe() { return "font name from the allowed list" + this.suffix(); }
}

export class MaxWidth extends Field {
  protected cleanPresent(value: unknown, path: string, st: ValidationState) {
    const [lo, hi] = MAX_WIDTH_RANGE;
    let n: number | null = null;
    if (typeof value === "number" && Number.isInteger(value)) n = value;
    else if (typeof value === "string") { const m = /^(\d{3,4})(?:px)?$/i.exec(value.trim()); n = m ? parseInt(m[1], 10) : null; }
    if (n === null || n < lo || n > hi) { st.error(path, `must be a pixel width like 1200px between ${lo}px and ${hi}px (got ${shortRepr(value)})`); return INVALID; }
    return `${n}px`;
  }
  describe() { return `e.g. 1200px (${MAX_WIDTH_RANGE[0]}-${MAX_WIDTH_RANGE[1]}px)${this.suffix()}`; }
}

export class ListOf extends Field {
  constructor(public item: Field | null, public o: { minItems?: number; maxItems?: number; default?: unknown } = {}) {
    super(o.default !== undefined ? { default: o.default } : {});
  }
  get minItems() { return this.o.minItems ?? 0; }
  get maxItems() { return this.o.maxItems ?? 50; }
  protected cleanItem(item: unknown, path: string, st: ValidationState): Cleaned { return this.item!.clean(item, path, st); }
  protected cleanPresent(value: unknown, path: string, st: ValidationState) {
    if (!Array.isArray(value)) { st.error(path, "must be a list"); return INVALID; }
    if (value.length > this.maxItems) { st.error(path, `has ${value.length} items (max ${this.maxItems})`); return INVALID; }
    if (value.length < this.minItems) { st.error(path, `needs at least ${this.minItems} item${this.minItems === 1 ? "" : "s"}`); return INVALID; }
    const out: unknown[] = [];
    value.forEach((raw, i) => {
      const c = this.cleanItem(raw, `${path}[${i}]`, st);
      if (c !== INVALID && c !== MISSING) out.push(c);
    });
    return out;
  }
  describe() { return `list of ${this.minItems}-${this.maxItems} × ${this.item ? this.item.describe() : "items"}`; }
}

export class Obj extends Field {
  constructor(public fields: Record<string, Field>, public o: { optional?: boolean; acceptStrAs?: string } = {}) { super({ optional: o.optional }); }
  protected whenAbsent(path: string, st: ValidationState) {
    if (this.optional) return this.cleanPresent({}, path, st);
    st.error(path, "is required");
    return INVALID;
  }
  protected cleanPresent(value: unknown, path: string, st: ValidationState) {
    if (typeof value === "string" && this.o.acceptStrAs) value = { [this.o.acceptStrAs]: value };
    if (!value || typeof value !== "object" || Array.isArray(value)) { st.error(path, "must be an object"); return INVALID; }
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(this.fields)) {
      const c = field.clean(Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined, join(path, key), st);
      if (c !== MISSING && c !== INVALID) out[key] = c;
    }
    for (const key of Object.keys(src)) if (!(key in this.fields)) st.note(path, `ignored unknown field ${shortRepr(key)}`);
    return out;
  }
  describe() { return "{" + Object.entries(this.fields).map(([k, f]) => `${k}: ${f.describe()}`).join(", ") + "}"; }
}
