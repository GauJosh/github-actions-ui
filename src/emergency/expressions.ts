// A subset of the GitHub Actions expression language (`${{ … }}`), shared by snapshot validation (browser), the
// executor and the emergency runner. Pure: no imports from ui, github or Node.
//
// Supported: literals (null, booleans, numbers, 'strings'), context property access (a.b, a['b']), ! == != < <= > >=
// && || and parentheses, and the functions listed in FUNCTIONS. Anything else (object filters `*`, hashFiles, …)
// is a parse or analysis error, so validation can refuse it before an emergency rather than evaluate it wrongly.

export type Expr =
  | { kind: "lit"; value: unknown }
  | { kind: "ctx"; name: string }
  | { kind: "prop"; object: Expr; name: string }
  | { kind: "index"; object: Expr; index: Expr }
  | { kind: "call"; name: string; args: Expr[] }
  | { kind: "not"; operand: Expr }
  | { kind: "bin"; op: string; left: Expr; right: Expr };

export class ExpressionError extends Error {}

/** Functions the runner implements. Status functions are only meaningful in `if:`. */
export const FUNCTIONS = new Set(["contains", "startswith", "endswith", "format", "join", "tojson", "fromjson", "success", "failure", "always", "cancelled"]);
export const STATUS_FUNCTIONS = new Set(["success", "failure", "always", "cancelled"]);

type Token = { t: "num" | "str" | "id" | "op"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let s = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new ExpressionError("Unterminated string");
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ t: "str", v: s });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("!<>()[].,".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    const num = /^(?:0x[0-9a-fA-F]+|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
    if (num && (c !== "-" || /\d/.test(src[i + 1] ?? ""))) {
      out.push({ t: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new ExpressionError(`Unsupported character ${JSON.stringify(c)}`);
  }
  return out;
}

/** Parses one expression (without the `${{ }}` delimiters). */
export function parseExpression(src: string): Expr {
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExpressionError(`Expected ${JSON.stringify(v)}`);
    p++;
  };

  const primary = (): Expr => {
    const tok = tokens[p++];
    if (!tok) throw new ExpressionError("Unexpected end of expression");
    if (tok.t === "num") return { kind: "lit", value: Number(tok.v) };
    if (tok.t === "str") return { kind: "lit", value: tok.v };
    if (tok.t === "op" && tok.v === "(") {
      const e = or();
      expect(")");
      return e;
    }
    if (tok.t === "op" && tok.v === "!") return { kind: "not", operand: unary() };
    if (tok.t !== "id") throw new ExpressionError(`Unexpected ${JSON.stringify(tok.v)}`);
    const lower = tok.v.toLowerCase();
    if (lower === "true" || lower === "false") return { kind: "lit", value: lower === "true" };
    if (lower === "null") return { kind: "lit", value: null };
    if (isOp("(")) {
      p++;
      const args: Expr[] = [];
      if (!isOp(")")) {
        for (;;) {
          args.push(or());
          if (isOp(",")) {
            p++;
            continue;
          }
          break;
        }
      }
      expect(")");
      return { kind: "call", name: lower, args };
    }
    return { kind: "ctx", name: lower };
  };

  const postfix = (): Expr => {
    let e = primary();
    for (;;) {
      if (isOp(".")) {
        p++;
        const tok = tokens[p++];
        if (!tok || tok.t !== "id") {
          if (tok?.t === "op" && tok.v === "*") throw new ExpressionError("Object filters (.*) are not supported");
          throw new ExpressionError("Expected a property name after '.'");
        }
        e = { kind: "prop", object: e, name: tok.v };
      } else if (isOp("[")) {
        p++;
        if (peek()?.t === "op" && peek()!.v === "*") throw new ExpressionError("Object filters ([*]) are not supported");
        const index = or();
        expect("]");
        e = { kind: "index", object: e, index };
      } else return e;
    }
  };
  const unary = (): Expr => {
    if (isOp("!")) {
      p++;
      return { kind: "not", operand: unary() };
    }
    return postfix();
  };
  const binary = (next: () => Expr, ops: string[]) => (): Expr => {
    let left = next();
    while (peek()?.t === "op" && ops.includes(peek()!.v)) {
      const op = tokens[p++]!.v;
      left = { kind: "bin", op, left, right: next() };
    }
    return left;
  };
  const comparison = binary(unary, ["<", "<=", ">", ">="]);
  const equality = binary(comparison, ["==", "!="]);
  const and = binary(equality, ["&&"]);
  const or: () => Expr = binary(and, ["||"]);

  const result = or();
  if (p !== tokens.length) throw new ExpressionError(`Unexpected ${JSON.stringify(tokens[p]!.v)}`);
  return result;
}

// ---- evaluation --------------------------------------------------------------------------------------------------

/** The status `if:` sees. "skipped": a needed job was skipped, so success(), failure() and cancelled() are all false. */
export type JobStatus = "success" | "failure" | "cancelled" | "skipped";
export type EvalContext = { contexts: Record<string, unknown>; status?: JobStatus };

export function truthy(v: unknown): boolean {
  return !(v === false || v === null || v === undefined || v === 0 || v === "" || (typeof v === "number" && Number.isNaN(v)));
}

function toNumber(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim() === "" ? 0 : Number(v);
  return Number.NaN;
}

/** GitHub's loose equality: strings compare case-insensitively; mixed types are compared as numbers. */
function looseEquals(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (typeof a === "object" && a !== null) return a === b;
  if (typeof b === "object" && b !== null) return false;
  return toNumber(a) === toNumber(b);
}

/** The string form GitHub uses when an expression is interpolated into text. */
export function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(v, null, 2);
}

function lookup(object: unknown, name: string): unknown {
  if (object === null || typeof object !== "object") return null;
  if (Array.isArray(object)) {
    const i = Number(name);
    return Number.isInteger(i) ? (object[i] ?? null) : null;
  }
  const rec = object as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rec, name)) return rec[name] ?? null;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : (rec[key] ?? null);
}

export function evaluate(e: Expr, ctx: EvalContext): unknown {
  switch (e.kind) {
    case "lit":
      return e.value;
    case "ctx":
      return lookup(ctx.contexts, e.name);
    case "prop":
      return lookup(evaluate(e.object, ctx), e.name);
    case "index":
      return lookup(evaluate(e.object, ctx), stringify(evaluate(e.index, ctx)));
    case "not":
      return !truthy(evaluate(e.operand, ctx));
    case "bin": {
      if (e.op === "&&") {
        const l = evaluate(e.left, ctx);
        return truthy(l) ? evaluate(e.right, ctx) : l;
      }
      if (e.op === "||") {
        const l = evaluate(e.left, ctx);
        return truthy(l) ? l : evaluate(e.right, ctx);
      }
      const l = evaluate(e.left, ctx);
      const r = evaluate(e.right, ctx);
      if (e.op === "==") return looseEquals(l, r);
      if (e.op === "!=") return !looseEquals(l, r);
      const [a, b] = typeof l === "string" && typeof r === "string" ? [l.toLowerCase(), r.toLowerCase()] : [toNumber(l), toNumber(r)];
      if (e.op === "<") return a < b;
      if (e.op === "<=") return a <= b;
      if (e.op === ">") return a > b;
      return a >= b;
    }
    case "call":
      return call(e.name, e.args, ctx);
  }
}

function call(name: string, args: Expr[], ctx: EvalContext): unknown {
  const v = () => args.map((a) => evaluate(a, ctx));
  const status = ctx.status ?? "success";
  switch (name) {
    case "success":
      return status === "success";
    case "failure":
      return status === "failure";
    case "cancelled":
      return status === "cancelled";
    case "always":
      return true;
    case "contains": {
      const [hay, needle] = v();
      if (Array.isArray(hay)) return hay.some((x) => looseEquals(x, needle));
      return stringify(hay).toLowerCase().includes(stringify(needle).toLowerCase());
    }
    case "startswith": {
      const [s, p] = v();
      return stringify(s).toLowerCase().startsWith(stringify(p).toLowerCase());
    }
    case "endswith": {
      const [s, p] = v();
      return stringify(s).toLowerCase().endsWith(stringify(p).toLowerCase());
    }
    case "format": {
      const [fmt, ...rest] = v();
      return stringify(fmt).replace(/\{\{|\}\}|\{(\d+)\}/g, (m, i: string | undefined) => (m === "{{" ? "{" : m === "}}" ? "}" : stringify(rest[Number(i)])));
    }
    case "join": {
      const [arr, sep] = v();
      return Array.isArray(arr) ? arr.map(stringify).join(sep === undefined || sep === null ? "," : stringify(sep)) : stringify(arr);
    }
    case "tojson":
      return JSON.stringify(v()[0] ?? null, null, 2);
    case "fromjson":
      return JSON.parse(stringify(v()[0]));
    default:
      throw new ExpressionError(`Function ${name}() is not supported`);
  }
}

// ---- templates and analysis --------------------------------------------------------------------------------------

const TEMPLATE = /\$\{\{([\s\S]*?)\}\}/g;

/** The `${{ }}` segments of a string, in order. */
export function templateExpressions(text: string): string[] {
  return [...text.matchAll(TEMPLATE)].map((m) => m[1]!.trim());
}

/** Replaces every `${{ expr }}` in `text`. A string that is exactly one expression keeps the value's type. */
export function interpolate(text: string, ctx: EvalContext): unknown {
  const whole = /^\s*\$\{\{([\s\S]*?)\}\}\s*$/.exec(text);
  if (whole && templateExpressions(text).length === 1) return evaluate(parseExpression(whole[1]!.trim()), ctx);
  return text.replace(TEMPLATE, (_m, src: string) => stringify(evaluate(parseExpression(src.trim()), ctx)));
}

export function interpolateString(text: string, ctx: EvalContext): string {
  return stringify(interpolate(text, ctx));
}

/** An `if:` value: with or without `${{ }}`; a bare value without a status function implies `success() && (…)`. */
export function parseCondition(raw: unknown): Expr {
  if (raw === undefined || raw === null || raw === "") return { kind: "call", name: "success", args: [] };
  if (typeof raw === "boolean" || typeof raw === "number") return { kind: "lit", value: raw };
  let text = String(raw).trim();
  const whole = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  if (whole && templateExpressions(text).length === 1) text = whole[1]!.trim();
  const e = parseExpression(text);
  return usesStatusFunction(e) ? e : { kind: "bin", op: "&&", left: { kind: "call", name: "success", args: [] }, right: e };
}

function usesStatusFunction(e: Expr): boolean {
  return walk(e).some((n) => n.kind === "call" && STATUS_FUNCTIONS.has(n.name));
}

function walk(e: Expr): Expr[] {
  switch (e.kind) {
    case "lit":
    case "ctx":
      return [e];
    case "prop":
      return [e, ...walk(e.object)];
    case "index":
      return [e, ...walk(e.object), ...walk(e.index)];
    case "not":
      return [e, ...walk(e.operand)];
    case "bin":
      return [e, ...walk(e.left), ...walk(e.right)];
    case "call":
      return [e, ...e.args.flatMap(walk)];
  }
}

/** A dotted path for a chain of property accesses with literal names, e.g. `secrets.TOKEN`; null otherwise. */
function pathOf(e: Expr): string | null {
  if (e.kind === "ctx") return e.name;
  if (e.kind === "prop") {
    const base = pathOf(e.object);
    return base === null ? null : `${base}.${e.name}`;
  }
  if (e.kind === "index" && e.index.kind === "lit" && typeof e.index.value === "string") {
    const base = pathOf(e.object);
    return base === null ? null : `${base}.${e.index.value}`;
  }
  return null;
}

export type ExpressionUse = { references: string[]; functions: string[]; dynamicContexts: string[] };

/**
 * What an expression reads: the longest literal context paths (`secrets.TOKEN`, `steps.a.outputs.b`), the
 * functions it calls, and contexts it indexes dynamically (`secrets[inputs.name]`), which validation can't resolve.
 */
export function analyse(e: Expr): ExpressionUse {
  const references = new Set<string>();
  const dynamicContexts = new Set<string>();
  const functions = new Set<string>();
  const visit = (n: Expr) => {
    if (n.kind === "call") {
      functions.add(n.name);
      n.args.forEach(visit);
      return;
    }
    if (n.kind === "ctx" || n.kind === "prop" || n.kind === "index") {
      const path = pathOf(n);
      if (path !== null) {
        references.add(path);
        return;
      }
      if (n.kind === "index") {
        const root = rootOf(n);
        if (root) dynamicContexts.add(root);
        visit(n.object);
        visit(n.index);
        return;
      }
      if (n.kind === "prop") visit(n.object);
      return;
    }
    if (n.kind === "not") visit(n.operand);
    if (n.kind === "bin") {
      visit(n.left);
      visit(n.right);
    }
  };
  visit(e);
  return { references: [...references], functions: [...functions], dynamicContexts: [...dynamicContexts] };
}

function rootOf(e: Expr): string | null {
  if (e.kind === "ctx") return e.name;
  if (e.kind === "prop" || e.kind === "index") return rootOf(e.object);
  return null;
}
