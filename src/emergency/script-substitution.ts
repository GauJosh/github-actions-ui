// Security review M1: putting `${{ }}` values into a `run:` script as data, never as script text.
//
// GitHub Actions pastes each `${{ }}` result into the script source before the shell runs it, so a value that
// contains shell or Python syntax becomes code (command injection through a step's output, a tool's stdout or a
// dispatch input). This module instead evaluates each expression to a string, binds it to an environment variable
// (`GHA_EXPR_0`, `GHA_EXPR_1`, …), and rewrites the occurrence as a reference the language reads as data. The value
// never appears in the script text, so it can never be parsed as syntax.
//
// A reference is only safe in some positions, so each occurrence's context is detected first:
// - shell, unquoted / double-quoted / single-quoted: supported;
// - shell inside command substitution (`$( … )` or backticks): rejected — a reference there would still be executed;
// - Python code position: supported (`os.environ[…]`);
// - Python inside a string literal or comment: rejected — pass the value through `env:` and read `os.environ` instead.
//
// Rejected contexts are refused at snapshot validation (src/emergency/prepare.ts) and again by the runner, so a
// snapshot that reached an outage can never fall back to direct interpolation. Pure: no I/O, no evaluation of its own.
import { evaluate, parseExpression, stringify, type EvalContext } from "./expressions.ts";

export type RunLanguage = "shell" | "python";
export type ExprContext = "unquoted" | "squote" | "dquote" | "python-code" | "unsafe";
export type ExprOccurrence = { expr: string; start: number; end: number; context: ExprContext };

const OPEN = "${{";
const CLOSE = "}}";

/** The reason an occurrence's context is unsafe, for a validation diagnostic. */
export function unsafeReason(language: RunLanguage): string {
  return language === "python"
    ? "a ${{ }} expression inside a Python string or comment can't be made safe; pass the value through env: and read os.environ"
    : "a ${{ }} expression inside a command substitution ($( ) or backticks) can't be made safe; assign it to a variable first";
}

/** Finds every `${{ }}` in a `run:` script and the context it sits in. Does not evaluate the expressions. */
export function scanRunExpressions(run: string, language: RunLanguage): ExprOccurrence[] {
  return language === "python" ? scanPython(run) : scanShell(run);
}

function templateEnd(run: string, open: number): number {
  const close = run.indexOf(CLOSE, open + OPEN.length);
  return close === -1 ? -1 : close + CLOSE.length;
}

function scanShell(run: string): ExprOccurrence[] {
  const out: ExprOccurrence[] = [];
  let mode: "normal" | "squote" | "dquote" = "normal";
  let cmdSub = 0; // depth of $( … ); backticks toggle it too
  for (let i = 0; i < run.length; ) {
    if (run.startsWith(OPEN, i)) {
      const end = templateEnd(run, i);
      if (end === -1) break;
      const context: ExprContext = cmdSub > 0 ? "unsafe" : mode === "normal" ? "unquoted" : mode;
      out.push({ expr: run.slice(i + OPEN.length, end - CLOSE.length).trim(), start: i, end, context });
      i = end;
      continue;
    }
    const c = run[i]!;
    if (mode === "squote") {
      if (c === "'") mode = "normal";
      i++;
      continue;
    }
    // normal or dquote
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      cmdSub += cmdSub > 0 ? -1 : 1;
      i++;
      continue;
    }
    if (c === "$" && run[i + 1] === "(") {
      cmdSub++;
      i += 2;
      continue;
    }
    if (c === ")" && cmdSub > 0) {
      cmdSub--;
      i++;
      continue;
    }
    if (mode === "normal") {
      if (c === "'") mode = "squote";
      else if (c === '"') mode = "dquote";
    } else if (c === '"') {
      mode = "normal";
    }
    i++;
  }
  return out;
}

function scanPython(run: string): ExprOccurrence[] {
  const out: ExprOccurrence[] = [];
  type State = { kind: "code" } | { kind: "comment" } | { kind: "string"; quote: string; triple: boolean; raw: boolean };
  let st: State = { kind: "code" };
  for (let i = 0; i < run.length; ) {
    if (run.startsWith(OPEN, i)) {
      const end = templateEnd(run, i);
      if (end === -1) break;
      out.push({ expr: run.slice(i + OPEN.length, end - CLOSE.length).trim(), start: i, end, context: st.kind === "code" ? "python-code" : "unsafe" });
      i = end;
      continue;
    }
    const c = run[i]!;
    if (st.kind === "comment") {
      if (c === "\n") st = { kind: "code" };
      i++;
      continue;
    }
    if (st.kind === "string") {
      if (!st.raw && c === "\\") {
        i += 2;
        continue;
      }
      if (c === st.quote && (!st.triple || run.startsWith(st.quote.repeat(3), i))) {
        i += st.triple ? 3 : 1;
        st = { kind: "code" };
        continue;
      }
      i++;
      continue;
    }
    // code
    if (c === "#") {
      st = { kind: "comment" };
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const triple = run.startsWith(c.repeat(3), i);
      const raw = /[rR]/.test(run.slice(Math.max(0, i - 2), i));
      st = { kind: "string", quote: c, triple, raw };
      i += triple ? 3 : 1;
      continue;
    }
    i++;
  }
  return out;
}

const VAR = (n: number) => `GHA_EXPR_${n}`;

/** The reference text that replaces an occurrence, reading variable `name` as data in its context. */
function reference(context: Exclude<ExprContext, "unsafe">, name: string): string {
  switch (context) {
    case "unquoted":
      return `"$${name}"`;
    case "dquote":
      return `\${${name}}`;
    case "squote":
      // Close the single quote, read the variable double-quoted (so its own contents are never re-parsed), reopen.
      return `'"$${name}"'`;
    case "python-code":
      return `os.environ[${JSON.stringify(name)}]`;
  }
}

export class UnsafeExpressionContextError extends Error {}

/**
 * Rewrites a `run:` script so every `${{ }}` becomes a reference to an environment variable holding its value.
 * Returns the rewritten script and the variables to set. Throws UnsafeExpressionContextError on a rejected context.
 */
export function substituteRunScript(run: string, language: RunLanguage, evalExpr: (exprSrc: string) => string): { script: string; env: Record<string, string> } {
  const occ = scanRunExpressions(run, language);
  const env: Record<string, string> = {};
  let script = "";
  let last = 0;
  occ.forEach((o, n) => {
    if (o.context === "unsafe") throw new UnsafeExpressionContextError(unsafeReason(language));
    const name = VAR(n);
    env[name] = evalExpr(o.expr);
    script += run.slice(last, o.start) + reference(o.context, name);
    last = o.end;
  });
  return { script: script + run.slice(last), env };
}

/** For validation: how many expressions a `run:` has, and the first rejected context's reason, without values. */
export function checkRunScript(run: string, language: RunLanguage): { count: number; reject?: string } {
  const occ = scanRunExpressions(run, language);
  const unsafe = occ.some((o) => o.context === "unsafe");
  return { count: occ.length, reject: unsafe ? unsafeReason(language) : undefined };
}

/** The runner's call: evaluates each expression against the context and masks nothing here (the caller masks logs). */
export function substituteRunWithContext(run: string, language: RunLanguage, ctx: EvalContext): { script: string; env: Record<string, string> } {
  return substituteRunScript(run, language, (src) => stringify(evaluate(parseExpression(src), ctx)));
}
