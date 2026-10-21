// Failure detection: annotations, failure signatures and text matches, their counts and scope, and how they reach
// step mapping and the step-first view. SYNTHETIC logs only (tools/fixture-server/failure-logs.ts).
import { describe, expect, it } from "vitest";
import { NODE_ACTION_JOB, NODE_ACTION_STEPS, SIGNATURE_CASES } from "../../../tools/fixture-server/failure-logs";
import { SAMPLE } from "../../../tools/fixture-server/noisy-log";
import { LogStore } from "../../logs/worker/store";
import { mapSteps, targetLine } from "../steps/step-map";
import type { Step } from "../types";
import { FOLD, classifyLines, evidenceRank, kindOf, reasonOf } from "./classify";
import { LogView, type StepSpec, type ViewRow, type ViewSource, type ViewSpec } from "./view";

function source(lines: string[]): ViewSource {
  const classified = classifyLines(lines);
  return { lineCount: lines.length, completeLines: lines.length, classified, text: (n) => lines[n]! };
}
const spec = (s: Partial<ViewSpec> = {}): ViewSpec => ({ mode: "essential", filters: [], context: 0, expanded: [], reveal: [], ...s });
function view(src: ViewSource, s: ViewSpec) {
  const v = new LogView();
  const summary = v.build(src, s);
  return { v, summary, rows: v.rowsAt(0, summary.rowCount) };
}
const lineNumbers = (rows: ViewRow[]) => rows.filter((r) => r.t === "line").map((r) => (r as { n: number }).n);
const store = (lines: string[]) => {
  const s = new LogStore();
  s.append(new TextEncoder().encode(lines.join("\n") + "\n"));
  s.finish();
  return s;
};
const steps = (list: readonly (readonly [string, string])[]): Step[] =>
  list.map(([name, conclusion], i) => ({ number: i + 1, name, status: "completed", conclusion, started_at: null, completed_at: null }));

describe("the missed Node.js failure (regression)", () => {
  const c = classifyLines(NODE_ACTION_JOB);
  const kind = (n: number) => kindOf(c.kinds[n]!);

  it("recognises `Error [ERR_…]:` as a failure signature, and its stack trace and error code as part of it", () => {
    expect(kind(20)).toBe("error-signature");
    expect(reasonOf(c.reasons[20]!)).toBe("failure signature: Node.js error with an error code");
    expect([21, 22, 23, 24].map(kind)).toEqual(Array(4).fill("stack"));
    expect([25, 26].map(kind)).toEqual(["stack", "stack"]);
    expect(reasonOf(c.reasons[25]!)).toBe("stack trace: error properties");
    // Before the fix every one of these lines was plain action output.
    expect(kind(28)).toBe("action-output");
    expect(c.folds[20]).toBe(FOLD.none);
  });

  it("is counted under Errors, as a signature (not an annotation and not a text match)", () => {
    const { summary } = view(source(NODE_ACTION_JOB), spec());
    expect(summary.counts.errors).toBe(1);
    expect(summary.tiers).toEqual({ annotations: 0, signatures: 1, text: 0, warnings: 0 });
    expect(summary.errorLines).toEqual([20]);
    expect(summary.topEvidence[0]).toMatchObject({ n: 20, tier: "signature", kind: "error-signature" });
  });

  it("Errors & warnings shows the exception with its whole stack trace and the step header", () => {
    const { rows } = view(source(NODE_ACTION_JOB), spec({ mode: "problems" }));
    expect(lineNumbers(rows)).toEqual([12, 20, 21, 22, 23, 24, 25, 26]);
  });

  it("reaches step mapping: the failed step's evidence, a confirmed boundary check, and the line to open", () => {
    const mapping = mapSteps(steps(NODE_ACTION_STEPS), store(NODE_ACTION_JOB).markers());
    expect(mapping.mapping).toBe("exact-checks-passed");
    const seg = mapping.segments.find((s) => s.stepNumber === 3)!;
    expect(seg).toMatchObject({ startLine: 13, endLine: 29, errorLines: [] });
    expect(seg.evidence).toEqual([{ line: 21, rank: 1 }]);
    expect(targetLine(seg, { conclusion: "failure" })).toBe(21);
  });
});

describe("failure signatures, heuristics and false positives", () => {
  for (const { name, lines, kinds } of SIGNATURE_CASES) {
    it(name, () => {
      const c = classifyLines(lines);
      for (const [n, expected] of kinds) expect(kindOf(c.kinds[n]!), `line ${n}: ${lines[n]}`).toBe(expected);
    });
  }

  it("ranks evidence: specific annotation, signature, test failure, exit-code-only annotation, text match", () => {
    const lines = ["##[error]Deployment target not found", "TypeError: x is not a function", "FAIL src/a.test.ts", "##[error]Process completed with exit code 1.", "error: retrying", "plain"];
    const c = classifyLines(lines);
    expect(lines.map((_, n) => evidenceRank(c.kinds[n]!, c.reasons[n]!))).toEqual([0, 1, 2, 3, 4, -1]);
  });

  it("a stack trace does not turn unrelated earlier output into an exception", () => {
    const lines = ["Compiling…", ...Array(12).fill("step"), "Error: late", ...Array(11).fill("x"), "    at f (/a.js:1:1)"];
    const c = classifyLines(lines);
    expect(kindOf(c.kinds[13]!)).toBe("error-text"); // too far above the trace to be its message
    expect(kindOf(c.kinds[25]!)).toBe("stack");
  });

  it("a group holding an exception and its trace is never folded", () => {
    const lines = ["##[group]Run ./deploy", "##[endgroup]", "##[group]Uploading", "Error: upload refused", "    at upload (/a.js:3:9)", "##[endgroup]"];
    const c = classifyLines(lines);
    expect([2, 3, 4].map((n) => c.folds[n])).toEqual([0, 0, 0]);
    expect(kindOf(c.kinds[3]!)).toBe("error-signature");
  });

  it("a Python traceback shows in full before its exception line in Errors & warnings", () => {
    const python = SIGNATURE_CASES.find((x) => x.name.startsWith("Python traceback"))!.lines;
    const { rows } = view(source(["unrelated", ...python]), spec({ mode: "problems" }));
    expect(lineNumbers(rows)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("counts follow the scope", () => {
  const src = source(SAMPLE);

  it("counts, tiers and error navigation cover only the selected step's lines", () => {
    const whole = view(src, spec()).summary;
    expect(whole.counts.errors).toBe(4);
    expect(whole.tiers).toEqual({ annotations: 1, signatures: 2, text: 1, warnings: 2 });
    const checkout = view(src, spec({ scope: [14, 24] })).summary;
    expect(checkout.counts.errors).toBe(0);
    expect(checkout.counts.commands).toBe(2);
    expect(checkout.errorLines).toEqual([]);
    const npmTest = view(src, spec({ scope: [37, 52] })).summary;
    expect(npmTest.counts.errors).toBe(4);
    expect(npmTest.errorLines).toEqual([46, 47, 48, 52]);
  });

  it("lines outside the scope are one expandable row each side, and search stays in the scope", () => {
    const { rows, summary } = view(src, spec({ mode: "all", scope: [37, 52], search: { query: "git", caseSensitive: false, wholeWord: false, regex: false, only: false } }));
    expect(rows[0]).toMatchObject({ t: "fold", kind: "outside", start: 0, end: 36 });
    expect(rows[rows.length - 1]).toMatchObject({ t: "fold", kind: "outside", start: 53, end: 56 });
    expect(summary.matches).toEqual([]);
  });
});

describe("step-first Essential output", () => {
  const src = source(SAMPLE);
  // Steps of SAMPLE: set up job, checkout, deploy-config, npm test (failed), post checkout, complete job.
  const located: StepSpec[] = [
    { number: 1, start: 0, end: 13, collapsed: true },
    { number: 2, start: 14, end: 24, collapsed: true },
    { number: 3, start: 25, end: 36, collapsed: true },
    { number: 4, start: 37, end: 52, collapsed: false },
    { number: 5, start: 53, end: 54, collapsed: true },
    { number: 6, start: 55, end: 56, collapsed: true },
  ];

  it("starts each step with a heading row; a collapsed step shows only its heading and a hint of its output", () => {
    const { rows, summary } = view(src, spec({ steps: located }));
    const headings = rows.filter((r) => r.t === "step") as Extract<ViewRow, { t: "step" }>[];
    expect(headings.map((h) => [h.number, h.collapsed])).toEqual(located.map((s) => [s.number, s.collapsed]));
    expect(summary.stepRows).toEqual(rows.flatMap((r, i) => (r.t === "step" ? [i] : [])));
    expect(lineNumbers(rows)).toEqual([37, 44, 45, 46, 47, 48, 49, 50, 51, 52]);
    expect(headings[2]!.preview).toMatchObject({ n: 36, text: SAMPLE[36] });
    expect(headings[3]!.tiers).toEqual({ annotations: 1, signatures: 2, text: 1, warnings: 2 });
    expect(summary.steps.find((s) => s.number === 4)!.evidence.map((e) => e.n)).toEqual([46, 47, 52]);
  });

  it("a hidden line resolves to its step's heading; revealing a line opens its step", () => {
    const { v, rows } = view(src, spec({ steps: located }));
    expect(rows[v.rowOf(31)]).toMatchObject({ t: "step", number: 3 });
    const revealed = view(src, spec({ steps: located, reveal: [31] }));
    expect(lineNumbers(revealed.rows)).toContain(31);
    expect(revealed.rows[revealed.summary.revealRows[0]!]).toMatchObject({ t: "line", n: 31 });
  });

  it("with every step open, every original line is shown or inside exactly one fold", () => {
    const open = located.map((s) => ({ ...s, collapsed: false }));
    const { rows } = view(src, spec({ steps: open }));
    const covered: number[] = [];
    for (const r of rows) {
      if (r.t === "line") covered.push(r.n);
      if (r.t === "fold") for (let n = r.start; n <= r.end; n++) covered.push(n);
    }
    expect(covered).toEqual(SAMPLE.map((_, i) => i));
    // A fold never crosses into the next step: its heading comes first.
    for (const r of rows) if (r.t === "fold") expect(located.some((s) => r.start < s.start && r.end >= s.start)).toBe(false);
  });

  it("All output and Errors & warnings ignore step headings", () => {
    expect(view(src, spec({ mode: "all", steps: located })).rows.some((r) => r.t === "step")).toBe(false);
    expect(view(src, spec({ mode: "problems", steps: located })).rows.some((r) => r.t === "step")).toBe(false);
  });
});

describe("failed step with no identifiable error line", () => {
  it("keeps the boundary warning and opens the step at its first line", () => {
    const lines = NODE_ACTION_JOB.map((l, i) => (i >= 16 && i <= 28 ? l.replace(/Z .*/, "Z publishing notes…") : l));
    const mapping = mapSteps(steps(NODE_ACTION_STEPS), store(lines).markers());
    expect(mapping.mapping).toBe("approximate");
    expect(mapping.issues).toContain("Step 3 failed, but no error line was found in its part of the log.");
    const seg = mapping.segments.find((s) => s.stepNumber === 3)!;
    expect(seg.evidence).toEqual([]);
    expect(targetLine(seg, { conclusion: "failure" })).toBe(seg.startLine);
  });
});
