// Failure impact (SYNTHETIC workflows and jobs): facts, GitHub's skip rules and unknowns kept apart.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildRunGraph, type RunGraph } from "../graph/build";
import { readWorkflowDefinition, type WorkflowDefinition } from "../graph/workflow-definition";
import type { Job, Step } from "../types";
import { analyzeImpact, hasStatusFunction } from "./impact";

const T0 = Date.parse("2026-10-21T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
let id = 0;
const job = (name: string, conclusion: string | null, start = 0, end = 10, steps?: Step[]): Job =>
  ({
    id: ++id,
    name,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    started_at: at(start),
    completed_at: conclusion === null ? null : at(end),
    html_url: null,
    steps: steps ?? [],
  }) as Job;
const step = (number: number, name: string, conclusion: string, end: number): Step => ({ number, name, status: "completed", conclusion, started_at: at(end - 5), completed_at: at(end) });
const def = (yaml: string) => readWorkflowDefinition(parse(yaml)) as WorkflowDefinition;
const graphOf = (yaml: string, jobs: Job[]): RunGraph => buildRunGraph(jobs, def(yaml), { file: { path: ".github/workflows/ci.yml", revision: "a".repeat(40) } });
const done = { status: "completed", conclusion: "failure" };

const CI = `
jobs:
  lint: { steps: [{ run: lint }] }
  unit: { steps: [{ run: test }] }
  build: { needs: [lint, unit], steps: [{ run: make }] }
  e2e: { needs: build, steps: [{ run: e2e }] }
  docs: { needs: lint, if: "github.ref == 'refs/heads/main'", steps: [{ run: docs }] }
  report: { needs: [build, e2e], if: always(), steps: [{ run: report }] }
  rollback: { needs: build, if: failure(), steps: [{ run: undo }] }
  publish: { needs: report, steps: [{ run: publish }] }
`;

describe("failure impact", () => {
  it("separates the failed job, the jobs not run because of it, the jobs that ran anyway, and unrelated skips", () => {
    const jobs = [
      job("lint", "success"),
      job("unit", "failure", 0, 40, [step(1, "Set up job", "success", 2), step(2, "Run tests", "failure", 38)]),
      job("build", "skipped"),
      job("e2e", "skipped"),
      job("docs", "skipped"),
      job("report", "success", 41, 45),
      job("rollback", "skipped"),
      job("publish", "success", 46, 50),
    ];
    const impact = analyzeImpact(graphOf(CI, jobs), done);
    expect(impact.failures.map((f) => f.label)).toEqual(["unit"]);
    const f = impact.failures[0]!;
    expect(f.jobs[0]!.step?.name).toBe("Run tests");
    expect(f.upstream).toEqual([]);
    const reasons = Object.fromEntries(f.downstream.map((d) => [d.key.replace("def:", ""), d.reason]));
    // build: no `if:`, a need failed -> blocked; e2e: below a blocked job -> blocked.
    // report: `always()` -> ran anyway, and nothing below it is attributed (publish ran on report's success).
    // rollback: `failure()` but skipped -> its condition decided (the data does not say why).
    expect(reasons).toEqual({ build: "blocked", e2e: "blocked", report: "ran-anyway", rollback: "possibly" });
    // docs was skipped by its own condition: not downstream of the failure, so not impact.
    expect(impact.unrelatedSkipped).toEqual(["def:docs"]);
    expect(f.edges).toEqual(expect.arrayContaining(["def:unit->def:build", "def:build->def:e2e", "def:build->def:report"]));
    expect(f.edges).not.toContain("def:report->def:publish");
  });

  it("does not let a failed job claim descendants that do not need it", () => {
    const jobs = [job("lint", "failure", 0, 5), job("unit", "success"), job("build", "skipped"), job("e2e", "skipped"), job("docs", "skipped"), job("report", "success"), job("rollback", "success"), job("publish", "success")];
    const [f] = analyzeImpact(graphOf(CI, jobs), done).failures;
    // docs needs lint, but its own `if:` (no status function) still gets GitHub's success() check: blocked.
    expect(f!.downstream.find((d) => d.key === "def:docs")?.reason).toBe("blocked");
    expect(f!.downstream.find((d) => d.key === "def:rollback")?.reason).toBe("recovery");
    expect(f!.downstream.some((d) => d.key === "def:unit")).toBe(false);
  });

  it("reports several independent failures, the earliest observed one (not called the cause), and a failure after a failure", () => {
    const yaml = `
jobs:
  a: { steps: [{ run: a }] }
  b: { steps: [{ run: b }] }
  c: { needs: a, steps: [{ run: c }] }
  d: { needs: b, steps: [{ run: d }] }
  cleanup: { needs: [a, b], if: always(), steps: [{ run: x }] }
`;
    const jobs = [job("a", "failure", 0, 90), job("b", "timed_out", 0, 30), job("c", "skipped"), job("d", "skipped"), job("cleanup", "failure", 91, 99)];
    const impact = analyzeImpact(graphOf(yaml, jobs), done);
    expect(impact.failures.map((f) => [f.label, f.kind])).toEqual([
      ["b", "timed_out"],
      ["a", "failure"],
      ["cleanup", "failure"],
    ]);
    expect(impact.earliest?.key).toBe("def:b");
    const cleanup = impact.failures.find((f) => f.label === "cleanup")!;
    expect(cleanup.failedUpstream.sort()).toEqual(["def:a", "def:b"]);
    expect(impact.failures.find((f) => f.label === "a")!.downstream.map((d) => [d.key, d.reason])).toEqual([
      ["def:c", "blocked"],
      ["def:cleanup", "ran-anyway"],
    ]);
  });

  it("marks attribution through a conditionally skipped job as possible, not established", () => {
    const yaml = `
jobs:
  a: { steps: [{ run: a }] }
  gate: { needs: a, if: "always() && github.event_name == 'push'", steps: [{ run: g }] }
  after: { needs: gate, steps: [{ run: z }] }
`;
    const [f] = analyzeImpact(graphOf(yaml, [job("a", "failure"), job("gate", "skipped"), job("after", "skipped")]), done).failures;
    expect(f!.downstream.map((d) => [d.key, d.reason])).toEqual([
      ["def:gate", "possibly"],
      ["def:after", "possibly"],
    ]);
  });

  it("says what cannot be established without the workflow file, and draws no impact", () => {
    const g = buildRunGraph([job("build", "failure"), job("deploy", "skipped")], null, { unavailableReason: "The token cannot read the workflow file." });
    const impact = analyzeImpact(g, done);
    expect(impact.dependencies).toBe("unavailable");
    expect(impact.failures[0]!.untraced).toBe(true);
    expect(impact.failures[0]!.downstream).toEqual([]);
    expect(impact.notes[0]).toMatch(/cannot be established/);
  });

  it("handles cancellation, a run still in progress, and a failed run without failed jobs", () => {
    const yaml = `jobs:\n  a: { steps: [{ run: a }] }\n  b: { needs: a, steps: [{ run: b }] }\n`;
    const cancelled = analyzeImpact(graphOf(yaml, [job("a", "cancelled"), job("b", "skipped")]), { status: "completed", conclusion: "cancelled" });
    expect(cancelled.failures[0]!.kind).toBe("cancelled");
    expect(cancelled.earliest).toBeUndefined();
    expect(cancelled.notes.join(" ")).toMatch(/does not report why a job was cancelled/);

    const running = analyzeImpact(graphOf(yaml, [job("a", "failure"), job("b", null)]), { status: "in_progress", conclusion: null });
    expect(running.failures[0]!.downstream[0]!.reason).toBe("pending");
    expect(running.notes.join(" ")).toMatch(/still in progress/);

    const none = analyzeImpact(graphOf(yaml, [job("a", "success"), job("b", "success")]), done);
    expect(none.failures).toEqual([]);
    expect(none.notes.join(" ")).toMatch(/no job in this attempt failed/);
  });

  it("recognises conditions that replace GitHub's default success() check", () => {
    expect(hasStatusFunction("always()")).toBe(true);
    expect(hasStatusFunction("${{ !cancelled() && inputs.deploy }}")).toBe(true);
    expect(hasStatusFunction("github.ref == 'refs/heads/main'")).toBe(false);
    expect(hasStatusFunction(undefined)).toBe(false);
  });
});
