import { ToolError, type ToolDef } from "./types";

const MAX_CHARS = 200;
const MAX_EXPONENT = 10_000;
const MAX_DEPTH = 40;
const TOO_LARGE = "That number is too large to calculate.";

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ t: "id", v: id[0].toLowerCase() }); i += id[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (two === "**" || two === "//") { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/%^(),".includes(c)) { out.push({ t: "op", v: c === "^" ? "**" : c }); i++; continue; }
    throw new ToolError(`unexpected character "${c}"`);
  }
  return out;
}

function pow(a: number, b: number): number {
  if (![0, 1, -1].includes(a)) {
    if (Math.abs(b) > MAX_EXPONENT || Math.abs(b) * Math.log10(Math.abs(a)) > 300) throw new ToolError(TOO_LARGE);
  }
  return Math.pow(a, b);
}

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, log10: Math.log10, pow,
  round: (x, n = 0) => { const f = 10 ** n; return Math.round((x + Number.EPSILON) * f) / f; },
  min: Math.min, max: Math.max,
  log: (x, base) => (base === undefined ? Math.log(x) : Math.log(x) / Math.log(base)),
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** Recursive-descent evaluator. Nothing here ever reaches eval() or Function(). */
export function evaluate(expression: string): number {
  if (expression.length > MAX_CHARS) throw new ToolError(`the expression is too long (max ${MAX_CHARS} characters)`);
  const toks = tokenize(expression);
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.t === "op" && (peek() as { v: string }).v === v;

  function expr(d: number): number {
    if (d > MAX_DEPTH) throw new ToolError("the expression is nested too deeply");
    let left = term(d);
    while (isOp("+") || isOp("-")) {
      const op = (toks[pos++] as { v: string }).v;
      const right = term(d);
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }
  function term(d: number): number {
    let left = unary(d);
    while (isOp("*") || isOp("/") || isOp("//") || isOp("%")) {
      const op = (toks[pos++] as { v: string }).v;
      const right = unary(d);
      if ((op === "/" || op === "//" || op === "%") && right === 0) throw new ToolError("division by zero");
      if (op === "*") left *= right;
      else if (op === "/") left /= right;
      else if (op === "//") left = Math.floor(left / right);
      else left = left - right * Math.floor(left / right);
    }
    return left;
  }
  function unary(d: number): number {
    if (d > MAX_DEPTH) throw new ToolError("the expression is nested too deeply");
    if (isOp("-")) { pos++; return -unary(d + 1); }
    if (isOp("+")) { pos++; return unary(d + 1); }
    const base = primary(d);
    if (isOp("**")) { pos++; return pow(base, unary(d + 1)); }
    return base;
  }
  function primary(d: number): number {
    const t = toks[pos++];
    if (!t) throw new ToolError("the expression ended unexpectedly");
    if (t.t === "num") return t.v;
    if (t.t === "op" && t.v === "(") {
      const v = expr(d + 1);
      if (!isOp(")")) throw new ToolError("missing closing parenthesis");
      pos++;
      return v;
    }
    if (t.t === "id") {
      if (isOp("(")) {
        const fn = FUNCS[t.v];
        if (!fn) throw new ToolError("only sqrt, abs, round, pow, min, max, floor, ceil, log, log10 are allowed");
        pos++;
        const args: number[] = [];
        if (!isOp(")")) {
          do { args.push(expr(d + 1)); } while (isOp(",") && ++pos);
        }
        if (!isOp(")")) throw new ToolError("missing closing parenthesis");
        pos++;
        if (!args.length) throw new ToolError(`${t.v}() needs at least one argument`);
        return fn(...args);
      }
      if (t.v in CONSTS) return CONSTS[t.v];
      throw new ToolError(`unknown name "${t.v}"`);
    }
    throw new ToolError(`unexpected "${(t as { v: string }).v}"`);
  }

  const result = expr(0);
  if (pos < toks.length) throw new ToolError(`unexpected "${(toks[pos] as { v: string | number }).v}"`);
  if (!Number.isFinite(result)) throw new ToolError(Number.isNaN(result) ? "the result isn't a real number" : TOO_LARGE);
  return result;
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  return String(Number(n.toPrecision(15)));
}

export const calculator: ToolDef = {
  name: "calculator",
  label: "Calculator",
  description:
    "Evaluate a plain arithmetic expression. Supports + - * / // % ** and parentheses, constants pi and e, and the functions sqrt(), abs(), round(), pow(), min(), max(), floor(), ceil(), log(), log10(). " +
    "Convert percentages to multiplication yourself first (e.g. '18% of 74500' -> '74500 * 0.18'); '%' is modulo. Use this for any math instead of computing it yourself.",
  parameters: {
    type: "object",
    properties: { expression: { type: "string", description: "A math expression, e.g. '(12 + 8) * 3' or 'sqrt(144) + 20'." } },
    required: ["expression"],
  },
  risk: "safe",
  modes: ["chat", "agent"],
  readOnly: true,
  parallel: true,
  describeCall: (a) => `Calculate ${String(a.expression ?? "").slice(0, 80)}`,
  async run(args) {
    const expression = typeof args.expression === "string" ? args.expression : "";
    if (!expression.trim()) throw new ToolError('"expression" is required.');
    try {
      const value = formatNumber(evaluate(expression));
      return { text: value, summary: `${expression.slice(0, 60)} = ${value}` };
    } catch (e) {
      const shown = expression.length > 60 ? expression.slice(0, 60) + "…" : expression;
      throw new ToolError(`Could not evaluate '${shown}': ${(e as Error).message}.`);
    }
  },
};
