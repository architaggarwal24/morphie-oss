/**
 * A tiny render tree with two serialisers. Each component describes its markup once as a
 * tree of nodes; the same tree becomes escaped HTML (preview + HTML export, from a
 * ConcreteCtx that reads the spec) and React JSX (from a SymbolicCtx that emits
 * expressions like `content.title`). One definition ⇒ the outputs can't drift, and every
 * literal passes through an escaping serialiser, so model text is never concatenated raw.
 */

export class Lit { constructor(public readonly text: string) {} }
/** A literal that came from a content field: the visual editor needs to know which one (`items.0.title`). */
export class EditLit extends Lit { constructor(text: string, public readonly path: string) { super(text); } }
export class Expr { constructor(public readonly code: string) {} }
export type Value = Lit | Expr;

export interface ElementNode { kind: "el"; tag: string; attrs: Record<string, Value>; children: Node[] }
export interface TextNode { kind: "text"; value: Value }
export interface EachNode { kind: "each"; expr: string; v: string; body: ElementNode | CompNode; index: string }
export interface WhenNode { kind: "when"; expr: string; body: ElementNode | CompNode }
export interface CompNode { kind: "comp"; name: string; props: Record<string, Value> }
export type Node = ElementNode | TextNode | EachNode | WhenNode | CompNode;

export type Child = string | Value | Node | null | undefined | Child[];

function asValue(v: unknown): Value {
  if (v instanceof Lit || v instanceof Expr) return v;
  if (typeof v === "string") return new Lit(v);
  throw new TypeError("Attribute values must be string, Lit or Expr");
}

function flatten(children: Child[]): Node[] {
  const out: Node[] = [];
  for (const c of children) {
    if (c == null) continue;
    if (Array.isArray(c)) out.push(...flatten(c));
    else if (typeof c === "string") out.push({ kind: "text", value: new Lit(c) });
    else if (c instanceof Lit || c instanceof Expr) out.push({ kind: "text", value: c });
    else out.push(c);
  }
  return out;
}

export function el(tag: string, attrs: Record<string, string | Value> | null, ...children: Child[]): ElementNode {
  return { kind: "el", tag, attrs: Object.fromEntries(Object.entries(attrs ?? {}).map(([k, v]) => [k, asValue(v)])), children: flatten(children) };
}
export const each = (expr: string, v: string, body: ElementNode | CompNode, index = "i"): EachNode => ({ kind: "each", expr, v, body, index });
export const when = (expr: string, body: ElementNode | CompNode): WhenNode => ({ kind: "when", expr, body });
export const comp = (name: string, props: Record<string, Value>): CompNode => ({ kind: "comp", name, props });

// ------------------------------------------------------------------ HTML

const VOID = new Set(["input", "br", "hr", "img", "meta", "link"]);
export function escapeHtml(s: string, quote = true): string {
  const r = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return quote ? r.replace(/"/g, "&quot;").replace(/'/g, "&#x27;") : r;
}

function htmlAttrs(attrs: Record<string, Value>): string {
  return Object.entries(attrs).map(([name, v]) => {
    if (!(v instanceof Lit)) throw new TypeError(`HTML output cannot contain the JSX expression for attribute '${name}'`);
    return ` ${name}="${escapeHtml(v.text)}"`;
  }).join("");
}

function htmlLines(node: Node, depth: number, editable = false): string[] {
  const pad = "  ".repeat(depth);
  if (node.kind === "text") {
    if (!(node.value instanceof Lit)) throw new TypeError("HTML output cannot contain a JSX expression");
    return [pad + escapeHtml(node.value.text, false)];
  }
  if (node.kind !== "el") throw new TypeError(`HTML output cannot contain ${node.kind} nodes`);
  // In the editor, an element whose only content is one field's text is marked with that field's path.
  const only = node.children.length === 1 && node.children[0].kind === "text" ? node.children[0].value : null;
  const mark = editable && only instanceof EditLit && only.text ? ` data-mf-edit="${escapeHtml(only.path)}"` : "";
  const open = `<${node.tag}${htmlAttrs(node.attrs)}${mark}>`;
  if (VOID.has(node.tag)) return [pad + open];
  const close = `</${node.tag}>`;
  if (!node.children.length) return [pad + open + close];
  if (node.children.every((c) => c.kind === "text")) return [pad + open + node.children.map((c) => htmlLines(c, 0)[0]).join("") + close];
  return [pad + open, ...node.children.flatMap((c) => htmlLines(c, depth + 1, editable)), pad + close];
}

export function toHtml(nodes: Child, indent = 0, opts: { editable?: boolean } = {}): string {
  return flatten([nodes]).flatMap((n) => htmlLines(n, indent, !!opts.editable)).join("\n");
}

// ------------------------------------------------------------------- JSX

const JSX_NAMES: Record<string, string> = { class: "className", for: "htmlFor", tabindex: "tabIndex" };
const PLAIN_ATTR = /^[A-Za-z0-9 _\-:./#,%]*$/;
const PLAIN_TEXT = /^[A-Za-z0-9 ,.\-!?:%$]*$/;

const jsString = (t: string) => JSON.stringify(t).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

function jsxAttrName(name: string): string {
  if (JSX_NAMES[name]) return JSX_NAMES[name];
  if (name.startsWith("aria-") || name.startsWith("data-") || !name.includes("-")) return name;
  const [head, ...rest] = name.split("-");
  return head + rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

function jsxAttrs(attrs: Record<string, Value>): string {
  return Object.entries(attrs).map(([name, v]) => {
    const n = jsxAttrName(name);
    if (v instanceof Expr) return ` ${n}={${v.code}}`;
    return PLAIN_ATTR.test(v.text) ? ` ${n}="${v.text}"` : ` ${n}={${jsString(v.text)}}`;
  }).join("");
}

function jsxText(v: Value): string {
  if (v instanceof Expr) return "{" + v.code + "}";
  return PLAIN_TEXT.test(v.text) && v.text === v.text.trim() && v.text ? v.text : "{" + jsString(v.text) + "}";
}

function withKey(body: ElementNode | CompNode, index: string): ElementNode | CompNode {
  const key = new Expr(index);
  return body.kind === "el" ? { ...body, attrs: { key, ...body.attrs } } : { ...body, props: { key, ...body.props } };
}

function jsxLines(node: Node, depth: number): string[] {
  const pad = "  ".repeat(depth);
  switch (node.kind) {
    case "text": return [pad + jsxText(node.value)];
    case "comp": return [pad + `<${node.name}${jsxAttrs(node.props)} />`];
    case "each": return [pad + `{${node.expr}.map((${node.v}, ${node.index}) => (`, ...jsxLines(withKey(node.body, node.index), depth + 1), pad + "))}"];
    case "when": return [pad + `{${node.expr} && (`, ...jsxLines(node.body, depth + 1), pad + ")}"];
    case "el": {
      const open = `<${node.tag}${jsxAttrs(node.attrs)}`;
      if (!node.children.length) return [pad + open + " />"];
      if (node.children.every((c) => c.kind === "text")) return [pad + open + ">" + node.children.map((c) => jsxLines(c, 0)[0]).join("") + `</${node.tag}>`];
      return [pad + open + ">", ...node.children.flatMap((c) => jsxLines(c, depth + 1)), pad + `</${node.tag}>`];
    }
  }
}

export const toJsx = (node: Node, indent = 0): string => jsxLines(node, indent).join("\n");

// --------------------------------------------------------------- contexts

const IDENT = /^[a-z_][a-z0-9_]*$/;
function checkField(f: string): string {
  if (!IDENT.test(f)) throw new Error(`Not a valid content field name: ${JSON.stringify(f)}`);
  return f;
}

/** How a component reads its content: real values (HTML) or JS expressions (JSX). */
export interface Ctx {
  text(field: string): Value;
  item(): Value;
  when(field: string, build: () => ElementNode | CompNode): Node | null;
  each(field: string, build: (c: Ctx) => ElementNode | CompNode): Node | Node[];
  cls(base: string, o?: { flags?: Record<string, string>; values?: Record<string, string>; counts?: Record<string, [string, number]> }): Value;
  anchor(field: string): Value;
  icon(field: string): ElementNode | CompNode;
  iconNamed(name: string): ElementNode | CompNode;
  initial(field: string): Value;
}

type IconFn = (name: string) => ElementNode;
let iconImpl: IconFn = () => { throw new Error("icons not loaded"); };
export function setIconImpl(fn: IconFn): void { iconImpl = fn; }

const joinPath = (a: string, b: string) => (a ? `${a}.${b}` : b);

export class ConcreteCtx implements Ctx {
  /** `path` (relative to the section, "" at its root) turns on field tracking for the visual editor. */
  constructor(private data: unknown, private path?: string) {}
  private get(field: string): any {
    checkField(field);
    return this.data && typeof this.data === "object" && !Array.isArray(this.data) ? (this.data as Record<string, unknown>)[field] : undefined;
  }
  text(field: string) { const v = this.get(field); const t = v == null ? "" : String(v); return this.path === undefined ? new Lit(t) : new EditLit(t, joinPath(this.path, field)); }
  item() { return this.path === undefined ? new Lit(String(this.data)) : new EditLit(String(this.data), this.path); }
  when(field: string, build: () => ElementNode | CompNode) { return this.get(field) ? build() : null; }
  each(field: string, build: (c: Ctx) => ElementNode | CompNode) {
    return ((this.get(field) as unknown[]) ?? []).map((it, i) => build(new ConcreteCtx(it, this.path === undefined ? undefined : joinPath(this.path, `${field}.${i}`))));
  }
  cls(base: string, o: { flags?: Record<string, string>; values?: Record<string, string>; counts?: Record<string, [string, number]> } = {}) {
    const parts = [base];
    for (const [f, c] of Object.entries(o.flags ?? {})) if (this.get(f)) parts.push(c);
    for (const [f, p] of Object.entries(o.values ?? {})) { const v = this.get(f); if (v != null) parts.push(`${p}${v}`); }
    for (const [f, [p, cap]] of Object.entries(o.counts ?? {})) parts.push(`${p}${Math.min(cap, Math.max(1, (this.get(f) ?? []).length))}`);
    return new Lit(parts.join(" "));
  }
  anchor(field: string) { const t = this.get(field); return new Lit(t ? `#${t}` : "#"); }
  icon(field: string) { return iconImpl(String(this.get(field) ?? "")); }
  iconNamed(name: string) { return iconImpl(name); }
  initial(field: string) { return new Lit(String(this.get(field) ?? "").trim().slice(0, 1).toUpperCase()); }
}

const LOOP_VARS: Array<[string, string]> = [["item", "i"], ["sub", "j"], ["leaf", "k"]];

export class SymbolicCtx implements Ctx {
  constructor(private v = "content", private depth = -1) {}
  private expr(field: string) { return `${this.v}.${checkField(field)}`; }
  text(field: string) { return new Expr(this.expr(field)); }
  item() { return new Expr(this.v); }
  when(field: string, build: () => ElementNode | CompNode) { return when(this.expr(field), build()); }
  each(field: string, build: (c: Ctx) => ElementNode | CompNode) {
    if (this.depth + 1 >= LOOP_VARS.length) throw new Error("Lists are nested too deeply for the JSX exporter");
    const [v, index] = LOOP_VARS[this.depth + 1];
    return each(this.expr(field), v, build(new SymbolicCtx(v, this.depth + 1)), index);
  }
  cls(base: string, o: { flags?: Record<string, string>; values?: Record<string, string>; counts?: Record<string, [string, number]> } = {}) {
    if (!o.flags && !o.values && !o.counts) return new Lit(base);
    if (base.includes("`") || base.includes("${")) throw new Error("Unsafe class name");
    let out = base;
    for (const [f, c] of Object.entries(o.flags ?? {})) out += `\${${this.expr(f)} ? " ${c}" : ""}`;
    for (const [f, p] of Object.entries(o.values ?? {})) out += ` ${p}\${${this.expr(f)}}`;
    for (const [f, [p, cap]] of Object.entries(o.counts ?? {})) out += ` ${p}\${Math.min(${Math.trunc(cap)}, Math.max(1, ${this.expr(f)}.length))}`;
    return new Expr("`" + out + "`");
  }
  anchor(field: string) { return new Expr(`"#" + (${this.expr(field)} || "")`); }
  icon(field: string) { return comp("Icon", { name: new Expr(this.expr(field)) }); }
  iconNamed(name: string) { return comp("Icon", { name: new Lit(name) }); }
  initial(field: string) { return new Expr(`(${this.expr(field)} || "").trim().charAt(0).toUpperCase()`); }
}
