import { describe, expect, it } from "vitest";
import { analyse, evaluate, ExpressionError, interpolate, interpolateString, parseCondition, parseExpression } from "./expressions.ts";

const ctx = (contexts: Record<string, unknown>, status?: "success" | "failure" | "cancelled") => ({ contexts, status });
const run = (src: string, contexts: Record<string, unknown> = {}) => evaluate(parseExpression(src), ctx(contexts));

describe("expressions", () => {
  it("reads contexts, properties and indexes case-insensitively, missing values as null", () => {
    const c = { inputs: { Version: "1.2" }, steps: { meta: { outputs: { version: "2" } } }, needs: {} };
    expect(run("inputs.version", c)).toBe("1.2");
    expect(run("steps.meta.outputs['version']", c)).toBe("2");
    expect(run("needs.build.outputs.x", c)).toBeNull();
  });

  it("follows GitHub's loose comparison and && / || value semantics", () => {
    expect(run("'ABC' == 'abc'")).toBe(true);
    expect(run("1 == '1'")).toBe(true);
    expect(run("null == 0")).toBe(true);
    expect(run("'' || 'fallback'")).toBe("fallback");
    expect(run("'a' && 'b'")).toBe("b");
    expect(run("!(1 < 2)")).toBe(false);
  });

  it("implements the supported functions", () => {
    expect(run("contains('Hello', 'ell')")).toBe(true);
    expect(run("contains(fromJSON('[\"a\",\"b\"]'), 'B')")).toBe(true);
    expect(run("startsWith('refs/tags/v1', 'refs/tags/')")).toBe(true);
    expect(run("format('{0}-{1} {{x}}', 'a', 2)")).toBe("a-2 {x}");
    expect(run("join(fromJSON('[1,2]'), '+')")).toBe("1+2");
  });

  it("evaluates if: conditions with an implicit success() unless a status function is used", () => {
    expect(evaluate(parseCondition("inputs.go == 'yes'"), ctx({ inputs: { go: "yes" } }, "failure"))).toBe(false);
    expect(evaluate(parseCondition("${{ always() }}"), ctx({}, "failure"))).toBe(true);
    expect(evaluate(parseCondition("failure()"), ctx({}, "failure"))).toBe(true);
    expect(evaluate(parseCondition(undefined), ctx({}, "success"))).toBe(true);
  });

  it("interpolates templates, keeping the type of a whole-string expression", () => {
    const c = ctx({ inputs: { n: 3, v: "1.0" } });
    expect(interpolate("${{ inputs.n }}", c)).toBe(3);
    expect(interpolateString("v=${{ inputs.v }} n=${{ inputs.n }}", c)).toBe("v=1.0 n=3");
  });

  it("refuses unsupported syntax instead of guessing", () => {
    expect(() => parseExpression("github.event.commits.*.message")).toThrow(ExpressionError);
    expect(() => run("hashFiles('**/x')")).toThrow(/not supported/);
    expect(() => parseExpression("a ? b : c")).toThrow(ExpressionError);
  });

  it("reports the context paths, functions and dynamic lookups an expression uses", () => {
    expect(analyse(parseExpression("secrets.TOKEN != '' && contains(github.ref, 'main')"))).toEqual({
      references: ["secrets.TOKEN", "github.ref"],
      functions: ["contains"],
      dynamicContexts: [],
    });
    expect(analyse(parseExpression("secrets[inputs.name]")).dynamicContexts).toEqual(["secrets"]);
  });
});
