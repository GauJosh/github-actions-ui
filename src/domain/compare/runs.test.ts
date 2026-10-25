// Run-to-run comparison (SYNTHETIC workflows and jobs).
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildRunGraph } from "../graph/build";
import { readWorkflowDefinition, type WorkflowDefinition } from "../graph/workflow-definition";
import type { Job, Run, Step } from "../types";
import { compareRuns, compareSteps, type Side } from "./runs";

const T0 = Date.parse("2026-10-21T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
let nextId = 0;
const step = (number: number, name: string, conclusion = "success"): Step => ({ number, name, status: "completed", conclusion, started_at: at(0), completed_at: at(1) });
const job = (name: string, conclusion: string, start = 0, end = 60, extra: Partial<Job> = {}): Job =>
  ({ id: ++nextId, name, status: "completed", conclusion, started_at: at(start), completed_at: at(end), html_url: null, steps: [step(1, "Set up job"), step(2, "Test", conclusion === "failure" ? "failure" : "success")], run_attempt: 1, ...extra }) as Job;
const run = (id: number, conclusion: string, extra: Partial<Run> = {}): Run =>
  ({ id, name: "ci", display_title: "ci", status: "completed", conclusion, run_attempt: 1, head_branch: "main", head_sha: String(id).repeat(40).slice(0, 40), html_url: "", event: "push", path: ".github/workflows/ci.yml", workflow_id: 7, ...extra }) as Run;
const side = (r: Run, jobs: Job[], yaml: string | null, attempt = r.run_attempt): Side => {
  const def = yaml ? (readWorkflowDefinition(parse(yaml)) as WorkflowDefinition) : null;
  const graph = buildRunGraph(jobs, def, def ? { file: { path: r.path!, revision: r.head_sha } } : { unavailableReason: "no file" });
  return { run: r, attempt, jobs, graph, workflowText: yaml };
};

const V1 = `
jobs:
  build: { steps: [{ run: make }] }
  test:
    name: unit (\${{ matrix.node }})
    needs: build
    strategy: { matrix: { node: [18, 20] } }
    steps: [{ run: test }]
  deploy: { name: deploy-app, needs: test, environment: prod, steps: [{ run: deploy }] }
  smoke: { needs: deploy, steps: [{ run: smoke }] }
`;
const V2 = `
jobs:
  build: { steps: [{ run: make }] }
  test:
    name: unit (\${{ matrix.node }})
    needs: build
    strategy: { matrix: { node: [18, 20, 22] } }
    steps: [{ run: test }]
  deploy: { needs: [build, test], environment: prod, steps: [{ run: deploy }] }
`;

describe("run comparison", () => {
  it("matches jobs by workflow identity, including matrix legs and renamed jobs", () => {
    const base = side(run(1, "success"), [job("build", "success"), job("unit (18)", "success"), job("unit (20)", "success", 0, 60), job("deploy-app", "success"), job("smoke", "success")], V1);
    const head = side(run(2, "failure"), [job("build", "success"), job("unit (18)", "success"), job("unit (20)", "failure", 0, 200), job("unit (22)", "success"), job("deploy", "skipped")], V2);
    const c = compareRuns(base, head);
    const by = (label: string) => c.jobs.find((j) => j.label === label)!;
    expect(by("test › 20")).toMatchObject({ basis: "workflow-file", change: "outcome", baseStatus: "success", headStatus: "failure" });
    expect(by("test › 22").change).toBe("added");
    expect(c.jobs.find((j) => j.base?.name === "smoke")?.change).toBe("removed");
    // deploy-app -> deploy: the same `deploy` job in the workflow file, so a rename, not a removal and an addition.
    expect(by("deploy")).toMatchObject({ change: "outcome", renamed: { from: "deploy-app", to: "deploy" } });
    expect(c.counts).toMatchObject({ nowFailing: 1, added: 1, removed: 1 });
    expect(c.graph.addedEdges).toEqual([["build", "deploy"]]);
    expect(c.graph.removedEdges).toEqual([["deploy", "smoke"]]);
    expect(c.graph.removedJobs).toEqual(["smoke"]);
    expect(c.workflow.file).toBe("changed");
    expect(c.environments).toEqual([{ environment: "prod", base: "success", head: "skipped" }]);
    expect(c.summary[0]).toBe("This run failed; the baseline succeeded.");
    expect(c.summary.join(" ")).toMatch(/not a proven cause/);
  });

  it("does not compare durations of jobs that did not both run to completion, and flags real regressions", () => {
    const base = side(run(1, "success"), [job("build", "success", 0, 60), job("unit (18)", "success", 0, 100)], V1);
    const head = side(run(2, "success"), [job("build", "success", 0, 200), job("unit (18)", "cancelled", 0, 10)], V1);
    const c = compareRuns(base, head);
    expect(c.jobs.find((j) => j.label === "build")!.duration).toMatchObject({ comparable: true, delta: 140_000, trend: "slower" });
    expect(c.jobs.find((j) => j.label === "test › 18")!.duration).toMatchObject({ comparable: false, why: "the job did not run to completion on both sides" });
  });

  it("gives the run duration no trend when one run was cancelled or failed", () => {
    const base = side(run(1, "cancelled"), [job("build", "cancelled", 0, 900)], V1);
    const head = side(run(2, "success"), [job("build", "success", 0, 140)], V1);
    const c = compareRuns(base, head);
    expect(c.duration).toMatchObject({ comparable: true, base: 900_000, head: 140_000 });
    expect(c.duration.trend).toBeUndefined();
    const pass = compareRuns(side(run(3, "success"), [job("build", "success", 0, 900)], V1), head);
    expect(pass.duration.trend).toBe("faster");
  });

  it("falls back to names without a workflow file, and says so", () => {
    const base = side(run(1, "success"), [job("build", "success")], null);
    const head = side(run(2, "success"), [job("build", "success")], V1);
    const c = compareRuns(base, head);
    expect(c.jobs[0]).toMatchObject({ basis: "name", change: "same" });
    expect(c.workflow.file).toBe("unavailable");
    expect(c.graph.available).toBe(false);
    expect(c.notes.join(" ")).toMatch(/baseline's workflow file was not available/);
  });

  it("offers a possible rename for unmatched jobs with the same steps, without merging them silently", () => {
    const steps = [step(1, "Set up job"), step(2, "Checkout"), step(3, "Lint"), step(4, "Complete job")];
    const base = side(run(1, "success"), [job("lint-old", "success", 0, 60, { steps })], null);
    const head = side(run(2, "success"), [job("lint-new", "success", 0, 60, { steps })], null);
    const c = compareRuns(base, head);
    expect(c.jobs).toHaveLength(1);
    expect(c.jobs[0]).toMatchObject({ basis: "possible-rename" });
    expect(c.jobs[0]!.notes[0]).toMatch(/Not certain/);
  });

  it("does not offer a possible rename when the match is ambiguous or the steps are too few or different", () => {
    const steps = [step(1, "Set up job"), step(2, "Checkout"), step(3, "Lint"), step(4, "Complete job")];
    // Two jobs in this run have the baseline job's steps: no pairing is guessed.
    let c = compareRuns(side(run(1, "success"), [job("lint-old", "success", 0, 60, { steps })], null), side(run(2, "success"), [job("lint-a", "success", 0, 60, { steps }), job("lint-b", "success", 0, 60, { steps })], null));
    expect(c.jobs.map((j) => j.change).sort()).toEqual(["added", "added", "removed"]);
    // Two baseline jobs share the steps of one job in this run.
    c = compareRuns(side(run(1, "success"), [job("lint-a", "success", 0, 60, { steps }), job("lint-b", "success", 0, 60, { steps })], null), side(run(2, "success"), [job("lint-new", "success", 0, 60, { steps })], null));
    expect(c.jobs.map((j) => j.change).sort()).toEqual(["added", "removed", "removed"]);
    // Two steps are too few to suggest the jobs are the same.
    const two = [step(1, "Set up job"), step(2, "Complete job")];
    c = compareRuns(side(run(1, "success"), [job("old", "success", 0, 60, { steps: two })], null), side(run(2, "success"), [job("new", "success", 0, 60, { steps: two })], null));
    expect(c.jobs.map((j) => j.change).sort()).toEqual(["added", "removed"]);
    // Different steps.
    c = compareRuns(side(run(1, "success"), [job("lint-old", "success", 0, 60, { steps })], null), side(run(2, "success"), [job("lint-new", "success", 0, 60, { steps: [...steps, step(5, "Extra")] })], null));
    expect(c.jobs.map((j) => j.change).sort()).toEqual(["added", "removed"]);
    expect(c.jobs.every((j) => j.basis !== "possible-rename")).toBe(true);
  });

  it("handles a side with no graph and no workflow file: name matching, unknown file, no dependencies or environments", () => {
    const base = side(run(1, "success"), [job("build", "success"), job("deploy-app", "success")], V1);
    const head: Side = { run: run(2, "failure"), attempt: 1, jobs: [job("build", "failure"), job("deploy-app", "success")], graph: null, workflowText: null };
    const c = compareRuns(base, head);
    expect(c.jobs.map((j) => [j.label, j.basis, j.change])).toEqual([
      ["build", "name", "outcome"],
      ["deploy-app", "name", "same"],
    ]);
    expect(c.jobs[0]!.headNode).toBeUndefined();
    expect(c.workflow.file).toBe("unavailable");
    expect(c.workflow.diff).toBeUndefined();
    expect(c.graph).toMatchObject({ available: false, addedEdges: [], removedEdges: [] });
    // The baseline's environment is listed with nothing on this side, rather than a status this run cannot show.
    expect(c.environments).toEqual([{ environment: "prod", base: "success", head: undefined }]);
    expect(c.notes.join(" ")).toMatch(/this run's workflow file was not available/);
    expect(c.summary.join(" ")).toMatch(/Whether the workflow file changed is unknown/);
  });

  it("compares two attempts of one run without mixing them, and labels jobs carried from another attempt", () => {
    const r1 = run(5, "failure", { run_attempt: 1 });
    const r2 = run(5, "success", { run_attempt: 2 });
    const a1 = side(r1, [job("build", "success", 0, 60, { run_attempt: 1 }), job("unit (18)", "failure", 0, 60, { run_attempt: 1 })], V1, 1);
    const a2 = side(r2, [job("build", "success", 0, 60, { run_attempt: 1 }), job("unit (18)", "success", 0, 60, { run_attempt: 2 })], V1, 2);
    const c = compareRuns(a1, a2);
    expect(c.sameExecution).toBe(false);
    expect(c.jobs.find((j) => j.label === "test › 18")).toMatchObject({ change: "outcome", headStatus: "success" });
    expect(c.jobs.find((j) => j.label === "build")!.notes).toEqual(["In this run, GitHub reports this job as run in attempt 1."]);
    expect(c.notes.join(" ")).toMatch(/reports as run in another attempt/);
    expect(c.summary.join(" ")).toMatch(/same commit/);
    expect(compareRuns(a2, a2).comparable).toEqual({ ok: false, reasons: ["Both sides are the same attempt of the same run."] });
  });

  it("compares two different runs at explicit earlier attempts, labelling jobs carried from another attempt on each side", () => {
    // Run 8 has 3 attempts and run 9 has 2; neither side is its run's latest attempt.
    const base = side(run(8, "failure", { run_attempt: 2 }), [job("build", "success", 0, 60, { run_attempt: 1 }), job("unit (18)", "failure", 0, 60, { run_attempt: 2 })], V1, 2);
    const head = side(run(9, "success", { run_attempt: 1 }), [job("build", "success", 0, 60, { run_attempt: 1 }), job("unit (18)", "success", 0, 60, { run_attempt: 1 })], V1, 1);
    const c = compareRuns(base, head);
    expect(c.sameExecution).toBe(false);
    expect(c.comparable.ok).toBe(true);
    const unit = c.jobs.find((j) => j.label === "test › 18")!;
    expect(unit).toMatchObject({ change: "outcome", baseStatus: "failure", headStatus: "success" });
    expect(unit.notes.join(" ")).not.toMatch(/attempt/);
    // The baseline's build ran in attempt 1, not the compared attempt 2: labelled, never treated as attempt 2's own.
    expect(c.jobs.find((j) => j.label === "build")!.notes).toEqual(["In the baseline, GitHub reports this job as run in attempt 1."]);
    expect(c.notes).toContain("GitHub lists 1 job in attempt 2 of the baseline that it reports as run in another attempt; they are compared as listed, and labelled.");
    expect(c.notes.join(" ")).not.toMatch(/of this run that it reports/);
  });

  it("reports a called (reusable) workflow that resolved to a different commit, and matches jobs inside the call", () => {
    const yaml = `jobs:\n  deploy: { uses: acme/shared/.github/workflows/deploy.yml@v2 }\n`;
    const ref = (sha: string) => [{ path: "acme/shared/.github/workflows/deploy.yml@v2", sha }];
    const base = side(run(1, "success", { referenced_workflows: ref("a".repeat(40)) }), [job("deploy / push", "success")], yaml);
    const head = side(run(2, "failure", { referenced_workflows: ref("b".repeat(40)) }), [job("deploy / push", "failure")], yaml);
    const c = compareRuns(base, head);
    expect(c.workflow.file).toBe("same");
    expect(c.workflow.called).toEqual([{ path: "acme/shared/.github/workflows/deploy.yml", base: "a".repeat(40), head: "b".repeat(40) }]);
    expect(c.jobs[0]).toMatchObject({ key: "wf:deploy#push", basis: "workflow-file", change: "outcome" });
    expect(c.summary.join(" ")).toMatch(/1 called workflow resolved to a different commit/);
  });

  it("matches steps by name and occurrence", () => {
    const d = compareSteps([step(1, "Run"), step(2, "Run"), step(3, "Old")], [step(1, "Run"), step(2, "Run", "failure"), step(3, "New")]);
    expect(d.map((x) => [x.name, x.change])).toEqual([
      ["Run", "same"],
      ["Run", "outcome"],
      ["Old", "removed"],
      ["New", "added"],
    ]);
  });
});
