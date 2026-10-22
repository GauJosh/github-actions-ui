// Run insights: statistics, critical path, timeline, workflow source and per-run deployments (SYNTHETIC data).
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildRunGraph, type RunGraph, type WorkflowFileRef } from "../graph/build";
import { buildHierarchyGraph, type WorkflowTree } from "../graph/hierarchy";
import { readWorkflowDefinition, type WorkflowDefinition } from "../graph/workflow-definition";
import { buildOverview, type ReleaseOverview } from "../phases/phases";
import type { Job } from "../types";
import { deploymentsOf } from "./deployments";
import { buildSourceTree, describeInput, flattenSource } from "./source";
import { computeRunStats, criticalPath } from "./stats";
import { buildTimeline, ticks } from "./timeline";

const T0 = Date.parse("2026-10-21T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
let id = 0;
/** A job that ran from `start` to `end` seconds (null: no timestamp), with a conclusion. */
const job = (name: string, conclusion: string | null, start: number | null, end: number | null, extra: Partial<Job> = {}): Job =>
  ({
    id: ++id,
    name,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    started_at: start === null ? null : at(start),
    completed_at: end === null ? null : at(end),
    html_url: null,
    steps: [],
    ...extra,
  }) as Job;
const def = (yaml: string) => readWorkflowDefinition(parse(yaml)) as WorkflowDefinition;
const file = (path: string): WorkflowFileRef => ({ repo: "acme/app", path, revision: "a".repeat(40), source: "run-commit" });
const graphOf = (yaml: string, jobs: Job[]): RunGraph => buildRunGraph(jobs, def(yaml), { file: { path: ".github/workflows/ci.yml", revision: "a".repeat(40) } });

const PIPE = `
jobs:
  build: { steps: [{ run: make }] }
  lint: { steps: [{ run: lint }] }
  test: { needs: build, steps: [{ run: test }] }
  deploy: { needs: [test, lint], environment: prod, steps: [{ run: deploy }] }
  rollback: { needs: deploy, if: failure(), steps: [{ run: undo }] }
`;

describe("run statistics", () => {
  it("counts by result, separates wall clock from summed job time, and ranks only timed jobs", () => {
    const jobs = [job("build", "success", 0, 60), job("lint", "success", 0, 30), job("test", "success", 70, 190), job("deploy", "failure", 200, 260), job("rollback", "skipped", 261, 261)];
    const s = computeRunStats(jobs, graphOf(PIPE, jobs));
    expect(s.counts).toEqual({ succeeded: 3, failed: 1, skipped: 1 });
    expect(s.wallClock).toEqual({ ms: 261_000, partial: false });
    expect(s.summedMs).toBe((60 + 30 + 120 + 60) * 1000); // the skipped job's timestamps are not a duration
    expect(s.timed).toBe(4);
    expect(s.slowest.map((t) => t.job.name)).toEqual(["test", "build", "deploy"]);
    expect(s.fastest.map((t) => t.job.name)).toEqual(["lint", "deploy", "build"]);
  });

  it("never treats missing timing as zero, and says a running run is partial", () => {
    const jobs = [job("build", "success", 0, 60), job("lint", "success", null, null), job("test", null, 70, null)];
    const s = computeRunStats(jobs, graphOf(PIPE, jobs));
    expect(s.missingTiming).toBe(1);
    expect(s.fastest.map((t) => t.job.name)).toEqual(["build"]);
    expect(s.wallClock).toEqual({ ms: 70_000, partial: true });
    expect(s.counts).toEqual({ succeeded: 2, running: 1 });
  });

  it("critical path: the longest chain of job durations through needs; parallel branches do not add up", () => {
    const jobs = [job("build", "success", 0, 60), job("lint", "success", 0, 200), job("test", "success", 70, 190), job("deploy", "success", 200, 260), job("rollback", "skipped", 261, 261)];
    const cp = criticalPath(graphOf(PIPE, jobs));
    // build (60) + test (120) + deploy (60) = 240 < lint (200) + deploy (60) = 260; the skipped rollback adds nothing.
    expect(cp).toEqual({ ms: 260_000, nodeKeys: ["def:lint", "def:deploy"], jobs: 2 });
  });

  it("critical path is unavailable, with the reason, when it cannot be measured", () => {
    const done = [job("build", "success", 0, 60), job("lint", "success", 0, 30), job("test", "success", 70, 190), job("deploy", "success", 200, 260), job("rollback", "skipped", 0, 0)];
    expect(criticalPath(buildRunGraph(done, null, {}))).toEqual({ unavailable: "Dependencies are unknown without the workflow file." });
    expect(criticalPath(graphOf("jobs: { a: { steps: [{ run: x }] }, b: { steps: [{ run: y }] } }", [job("a", "success", 0, 1), job("b", "success", 0, 2)]))).toHaveProperty("unavailable", expect.stringContaining("no dependencies"));
    const missing = [job("build", "success", null, null), ...done.slice(1)];
    expect(criticalPath(graphOf(PIPE, missing))).toHaveProperty("unavailable", expect.stringContaining("ran without timestamps"));
    const running = [job("build", null, 0, null), ...done.slice(1)];
    expect(criticalPath(graphOf(PIPE, running))).toHaveProperty("unavailable", expect.stringContaining("still running"));
  });
});

describe("timeline", () => {
  it("places bars at start offsets with their durations; queue time is separate; no bar without timestamps", () => {
    const jobs = [
      job("build", "success", 0, 60, { created_at: at(-20) }),
      job("lint", "success", 5, 30),
      job("test", null, 70, null),
      job("deploy", "skipped", 90, 90),
      job("rollback", "success", null, null),
    ];
    const tl = buildTimeline(jobs, graphOf(PIPE, jobs));
    expect(tl.origin).toBe(T0);
    expect(tl.span).toBe(90_000); // to the latest reported timestamp, never "now"
    const row = (n: string) => tl.groups.flatMap((g) => g.rows).find((r) => r.job.name === n)!;
    expect(row("build")).toMatchObject({ start: 0, end: 60_000, timing: "complete" });
    expect(row("build").queuedFrom).toBe(0); // queued before the axis start: clipped to it, never shifting the axis
    expect(row("lint")).toMatchObject({ start: 5_000, end: 30_000 });
    expect(row("test")).toMatchObject({ start: 70_000, end: 90_000, timing: "running" });
    expect(row("deploy")).toMatchObject({ timing: "skipped" });
    expect(row("deploy").start).toBeUndefined();
    expect(row("rollback")).toMatchObject({ timing: "missing" });
    expect(tl.edges).toContainEqual({ from: row("build").job.id, to: row("test").job.id });
    expect(tl.grouping).toBe("none");
  });

  it("draws queue time when the job was created after the axis start", () => {
    const jobs = [job("build", "success", 0, 60), job("test", "success", 70, 100, { created_at: at(61) })];
    const tl = buildTimeline(jobs, graphOf(PIPE, jobs));
    expect(tl.groups[0]!.rows.find((r) => r.job.name === "test")).toMatchObject({ queuedFrom: 61_000, start: 70_000 });
  });

  it("with no started job there is no axis", () => {
    expect(buildTimeline([job("build", "skipped", null, null)]).origin).toBeUndefined();
  });

  it("groups by phase when phases are given, in order of first start", () => {
    const jobs = [job("build", "success", 0, 60), job("lint", "success", 0, 30), job("test", "success", 70, 190), job("deploy", "success", 200, 260)];
    const g = graphOf(PIPE, jobs);
    const tl = buildTimeline(jobs, g, [
      { id: "env:prod", name: "prod", nodeKeys: ["def:deploy", "def:rollback"] },
      { id: "pre", name: "Before deployment", nodeKeys: ["def:build", "def:lint", "def:test"] },
    ]);
    expect(tl.grouping).toBe("phases");
    expect(tl.groups.map((x) => [x.label, x.rows.map((r) => r.job.name)])).toEqual([
      ["Before deployment", ["build", "lint", "test"]],
      ["prod", ["deploy"]],
    ]);
  });

  it("handles a large run quickly", () => {
    const many = Array.from({ length: 3000 }, (_, i) => job(`job ${i}`, "success", i, i + 30));
    const t0 = performance.now();
    const tl = buildTimeline(many);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(tl.groups[0]!.rows).toHaveLength(3000);
  });

  it("ticks at a readable step", () => {
    expect(ticks(90_000)).toEqual([0, 15_000, 30_000, 45_000, 60_000, 75_000, 90_000]);
  });
});

describe("workflow source", () => {
  const CALLER = def(`
jobs:
  build: { steps: [{ run: make }] }
  dev: { needs: build, uses: ./.github/workflows/env.yml, with: { environment: dev, api_token: abc, region: "\${{ vars.REGION }}", password_ref: x } }
  prod: { needs: dev, uses: ./.github/workflows/env.yml, with: { environment: prod, key: "\${{ secrets.DEPLOY_KEY }}" } }
  audit: { needs: prod, uses: org/shared/.github/workflows/audit.yml@main }
`);
  const ENV = def(`
jobs:
  deploy: { environment: "\${{ inputs.environment }}", steps: [{ run: deploy }] }
  smoke: { needs: deploy, steps: [{ run: smoke }] }
`);
  const envTree = (): WorkflowTree => ({ file: file(".github/workflows/env.yml"), definition: ENV, calls: new Map() });
  const tree: WorkflowTree = {
    file: file(".github/workflows/release.yml"),
    definition: CALLER,
    calls: new Map<string, WorkflowTree>([
      ["dev", envTree()],
      ["prod", envTree()],
      ["audit", { definition: null, unavailable: "GitHub did not report which commit `main` resolved to.", calls: new Map() }],
    ]),
  };
  const jobs = [job("build", "success", 0, 10), job("dev / deploy", "success", 11, 20), job("dev / smoke", "success", 21, 30), job("prod / deploy", "failure", 31, 40), job("prod / smoke", "skipped", 41, 41), job("audit", "skipped", 41, 41)];

  it("shows nested calls with separate identities, each file's revision, and why a file was not read", () => {
    const src = buildSourceTree(tree, buildHierarchyGraph(jobs, tree));
    expect(flattenSource(src).map((n) => [n.path.join("/"), n.labels.join(" › "), n.file?.path ?? n.unavailable])).toEqual([
      ["", "", ".github/workflows/release.yml"],
      ["dev", "dev", ".github/workflows/env.yml"],
      ["prod", "prod", ".github/workflows/env.yml"],
      ["audit", "audit", "GitHub did not report which commit `main` resolved to."],
    ]);
  });

  it("links declarations to what ran only through the graph's match", () => {
    const src = buildSourceTree(tree, buildHierarchyGraph(jobs, tree));
    const prod = src.jobs.find((j) => j.id === "prod")!.call!;
    expect(prod.jobs.map((j) => [j.id, j.run])).toEqual([
      ["deploy", { nodeKey: "def:prod/deploy", jobs: 1, status: "failure" }],
      ["smoke", { nodeKey: "def:prod/smoke", jobs: 1, status: "skipped" }],
    ]);
    expect(src.jobs.find((j) => j.id === "dev")!.run).toBeUndefined(); // expanded: its jobs are linked inside
    expect(src.jobs.find((j) => j.id === "build")!.run).toMatchObject({ nodeKey: "def:build" });
    const noRun = buildSourceTree(tree, buildHierarchyGraph(jobs.filter((j) => j.name !== "build"), tree));
    expect(noRun.jobs.find((j) => j.id === "build")!.run).toEqual({ declaredOnly: true });
  });

  it("shows caller inputs with provenance and never shows secret or credential-like values", () => {
    const src = buildSourceTree(tree, null);
    expect(src.jobs.find((j) => j.id === "dev")!.inputs).toEqual([
      { name: "environment", value: "dev", kind: "literal" },
      { name: "api_token", kind: "redacted", note: "the input name suggests a credential; not shown" },
      { name: "region", value: "${{ vars.REGION }}", kind: "expression", note: "evaluated when the run executed; its value is not in the workflow file" },
      { name: "password_ref", kind: "redacted", note: "the input name suggests a credential; not shown" },
    ]);
    expect(src.jobs.find((j) => j.id === "prod")!.inputs![1]).toEqual({ name: "key", kind: "redacted", note: "references a secret; not shown" });
    expect(JSON.stringify(src)).not.toContain("DEPLOY_KEY");
    expect(JSON.stringify(src)).not.toContain("abc");
    expect(describeInput("token_ttl", "${{ github.token }}").kind).toBe("redacted");
  });
});

describe("deployments in one run", () => {
  it("one record per environment with outcome and timing; skipped jobs are not deployment time", () => {
    const CD = def(`
jobs:
  deploy-dev: { environment: dev, steps: [{ run: d }] }
  smoke-dev: { needs: deploy-dev, steps: [{ run: s }] }
  rollback-dev: { needs: smoke-dev, if: failure(), steps: [{ run: r }] }
  deploy-prod: { needs: rollback-dev, environment: prod, steps: [{ run: d }] }
`);
    const jobs = [job("deploy-dev", "failure", 0, 30), job("smoke-dev", "skipped", 31, 31), job("rollback-dev", "success", 40, 60), job("deploy-prod", "skipped", 61, 61)];
    const g = buildRunGraph(jobs, CD, { file: { path: "cd.yml", revision: "a".repeat(40) } });
    const o = buildOverview(g, CD, { manifest: null }) as ReleaseOverview;
    const records = deploymentsOf({ id: 7, run_attempt: 1, head_sha: "c".repeat(40) }, g, o);
    expect(records.map((r) => [r.environment, r.outcome, r.startedAt, r.completedAt, r.provenance])).toEqual([
      ["dev", "rolled back", at(0), at(30), "declared"],
      ["prod", "skipped", undefined, undefined, "declared"],
    ]);
  });
});
