// Security review M1: the context-aware substitution that keeps ${{ }} values out of a run: script's text.
// These are direct, pure tests of the logic; execution-level proof with real shells is in tools/emergency/runner-check.ts.
import { describe, expect, it } from "vitest";
import { checkRunScript, scanRunExpressions, substituteRunScript, substituteRunWithContext, UnsafeExpressionContextError } from "./script-substitution.ts";

// A value made only of harmless marker text and the metacharacters an attacker would use; it must never run.
const PAYLOAD = `"; : INERT; echo INERT_MARKER; $(: INERT) \`: INERT\` ' end`;
const context = { contexts: { steps: { tool: { outputs: { v: PAYLOAD } } } } };
const E = "${{ steps.tool.outputs.v }}";

describe("scanRunExpressions: shell contexts", () => {
  it("classifies unquoted, double-quoted and single-quoted positions", () => {
    const run = `echo ${E}\necho "x ${E}"\necho 'y ${E}'`;
    expect(scanRunExpressions(run, "shell").map((o) => o.context)).toEqual(["unquoted", "dquote", "squote"]);
  });
  it("rejects command-substitution positions ($( ) and backticks)", () => {
    expect(scanRunExpressions(`echo $(${E})`, "shell")[0]!.context).toBe("unsafe");
    expect(scanRunExpressions("echo `" + E + "`", "shell")[0]!.context).toBe("unsafe");
    // A closed substitution does not poison a later safe position: [0] is unsafe (inside $( )), [1] is safe.
    expect(scanRunExpressions(`echo $(${E}) "${E}"`, "shell").map((o) => o.context)).toEqual(["unsafe", "dquote"]);
  });
  it("tracks escapes and quote nesting", () => {
    expect(scanRunExpressions(`echo "he said \\"${E}\\""`, "shell")[0]!.context).toBe("dquote");
    expect(scanRunExpressions(`echo "a" ${E}`, "shell")[0]!.context).toBe("unquoted");
  });
});

describe("scanRunExpressions: python contexts", () => {
  it("accepts code position and rejects string literals and comments", () => {
    expect(scanRunExpressions(`x = ${E}`, "python")[0]!.context).toBe("python-code");
    expect(scanRunExpressions(`print("v ${E}")`, "python")[0]!.context).toBe("unsafe");
    expect(scanRunExpressions(`print('''v ${E}''')`, "python")[0]!.context).toBe("unsafe");
    expect(scanRunExpressions(`# note ${E}`, "python")[0]!.context).toBe("unsafe");
  });
  it("sees that a closed string does not swallow a later code-position expression", () => {
    expect(scanRunExpressions(`s = "x ${E}"\ny = ${E}`, "python").map((o) => o.context)).toEqual(["unsafe", "python-code"]);
  });
});

describe("substituteRunScript", () => {
  it("puts the value in the environment, never in the script text", () => {
    const run = `echo ${E}\necho "d ${E}"\necho 'q ${E}'`;
    const { script, env } = substituteRunScript(run, "shell", () => PAYLOAD);
    expect(Object.values(env)).toEqual([PAYLOAD, PAYLOAD, PAYLOAD]);
    // The value's bytes never appear in the script; only references do.
    expect(script).not.toContain("INERT_MARKER");
    expect(script).not.toContain(PAYLOAD);
    expect(script).toBe(`echo "$GHA_EXPR_0"\necho "d \${GHA_EXPR_1}"\necho 'q '"$GHA_EXPR_2"''`);
  });
  it("references the value as data in python code position", () => {
    const { script, env } = substituteRunScript(`x = ${E}`, "python", () => PAYLOAD);
    expect(script).toBe(`x = os.environ["GHA_EXPR_0"]`);
    expect(env.GHA_EXPR_0).toBe(PAYLOAD);
  });
  it("throws on an unsafe context rather than interpolating", () => {
    expect(() => substituteRunScript(`echo $(${E})`, "shell", () => PAYLOAD)).toThrow(UnsafeExpressionContextError);
    expect(() => substituteRunScript(`print("${E}")`, "python", () => PAYLOAD)).toThrow(/env:/);
  });
  it("leaves a script with no expressions, and its env, untouched", () => {
    expect(substituteRunScript("echo hello\n", "shell", () => "x")).toEqual({ script: "echo hello\n", env: {} });
  });
});

describe("checkRunScript (validation, no values)", () => {
  it("counts safe expressions and reports the first rejected context", () => {
    expect(checkRunScript(`echo "${E}" ${E}`, "shell")).toEqual({ count: 2 });
    expect(checkRunScript(`echo $(${E})`, "shell").reject).toMatch(/command substitution/);
    expect(checkRunScript(`print("${E}")`, "python").reject).toMatch(/env:/);
    expect(checkRunScript("echo no expressions", "shell")).toEqual({ count: 0 });
  });
});

describe("substituteRunWithContext end to end", () => {
  it("evaluates the expression against the context and binds the raw value", () => {
    const { script, env } = substituteRunWithContext(`echo "v: ${E}"`, "shell", context);
    expect(script).toBe(`echo "v: \${GHA_EXPR_0}"`);
    expect(env.GHA_EXPR_0).toBe(PAYLOAD);
  });
});
