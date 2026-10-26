// Historical run performance (SYNTHETIC runs and jobs).
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildRunGraph } from "../graph/build";
import { readWorkflowDefinition, type WorkflowDefinition } from "../graph/workflow-definition";
import type { Job, Run } from "../types";
import { chartSeries, compareToBaseline, durationTrend, measure, median, outcomes, rankJobs, runDuration, type HistoryRun } from "./history";

const T0 = Date.parse("2026-10-21T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
let nextId = 0;
/** A job that ran from `start` to `end` seconds (null: no timestamp). */
const job = (name: string, conclusion: string, start: number | null, end: number | null, extra: Partial<Job> = {}): Job =>
  ({ id: ++nextId, name, status: "completed", conclusion, started_at: start === null ? null : at(start), completed_at: end === null ? null : at(end), html_url: null, steps: [], ...extra }) as Job;
/** Run `n` of workflow 7, started `n` hours after T0. */
const run = (n: number, conclusion: string, extra: Partial<Run> = {}): Run =>
  ({ id: 1000 + n, name: "ci", display_title: "ci", status: "completed", conclusion, run_attempt: 1, run_number: n, head_branch: "main", head_sha: "a".repeat(40), html_url: "", event: "push", path: ".github/workflows/ci.yml", workflow_id: 7, run_started_at: at(n * 3600), ...extra }) as Run;
const side = (r: Run, jobs: Job[], yaml: string | null = null): HistoryRun => {
  const def = yaml ? (readWorkflowDefinition(parse(yaml)) as WorkflowDefinition) : null;
  const graph = buildRunGraph(jobs, def, def ? { file: { path: r.path!, revision: r.head_sha } } : { unavailableReason: "no file" });
  return { run: r, attempt: r.run_attempt, jobs, graph };
};
/** A successful run whose single job took `secs` seconds. */
const timed = (n: number, secs: number, extra: Partial<Run> = {}) => side(run(n, "success", extra), [job("build", "success", n * 3600, n * 3600 + secs)]);

describe("historical performance", () => {
  it("measures durations only from valid timestamps; 0 ms is a real duration", () => {
    expect(measure(at(0), at(90))).toEqual({ ms: 90_000 });
    expect(measure(at(5), at(5))).toEqual({ ms: 0 });
    expect(measure(null, at(5))).toEqual({ unavailable: "missing timestamps" });
    expect(measure(at(9), at(5))).toEqual({ unavailable: "invalid timestamps" });
    expect(measure("not a time", at(5))).toEqual({ unavailable: "invalid timestamps" });
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });

  it("run duration: first job start to last job end; skipped jobs ignored; incomplete or untimed runs are not measured", () => {
    const r = side(run(1, "success"), [job("a", "success", 10, 70), job("b", "success", 30, 130), job("c", "skipped", null, null)]);
    expect(runDuration(r)).toEqual({ ms: 120_000 });
    expect(runDuration(side(run(2, "success"), [job("a", "success", 10, null)]))).toEqual({ unavailable: "missing timestamps" });
    expect(runDuration(side(run(3, "success"), [job("a", "success", 70, 10)]))).toEqual({ unavailable: "invalid timestamps" });
    expect(runDuration(side(run(4, "skipped"), [job("a", "skipped", null, null)]))).toEqual({ unavailable: "no jobs ran" });
    expect(runDuration(side(run(5, null as unknown as string, { status: "in_progress" }), [job("a", "success", 0, 5, { status: "in_progress" })]))).toEqual({
      unavailable: "in progress",
    });
  });

  it("trend: in start order, conclusions kept, unmeasurable runs labelled, other workflows and duplicates excluded", () => {
    const failed = side(run(2, "failure"), [job("build", "failure", 7200, 7230)]);
    const cancelled = side(run(3, "cancelled"), [job("build", "cancelled", null, null)]);
    const other = timed(4, 10, { workflow_id: 8, path: ".github/workflows/other.yml" });
    const t = durationTrend([timed(5, 50), failed, timed(1, 40), cancelled, other, timed(1, 40)]);
    expect(t.points.map((p) => [p.runNumber, p.conclusion, p.duration])).toEqual([
      [1, "success", { ms: 40_000 }],
      [2, "failure", { ms: 30_000 }],
      [3, "cancelled", { unavailable: "missing timestamps" }],
      [5, "success", { ms: 50_000 }],
    ]);
    expect(t.excluded.map((e) => [e.runId, e.why])).toEqual([
      [1004, "a different workflow"],
      [1001, "the same run attempt was supplied twice"],
    ]);
  });

  it("ranks jobs by median successful duration, keeps matrix legs and same-named jobs apart, and counts stopped jobs separately", () => {
    const yaml = `
jobs:
  build: { steps: [{ run: make }] }
  test:
    name: test (\${{ matrix.os }})
    strategy: { matrix: { os: [linux, windows] } }
    steps: [{ run: test }]
  lint: { name: build, steps: [{ run: lint }] }
`;
    // `lint` has the display name "build", like the `build` job: different workflow identities, never combined.
    const runs = [1, 2, 3].map((n) => {
      const s = n * 3600;
      return side(run(n, n === 2 ? "failure" : "success"), [job("build", "success", s, s + 100), job("test (linux)", "success", s, s + 300), job("test (windows)", n === 2 ? "failure" : "success", s, s + 600 * n), job("build", "success", s, s + 20)], yaml);
    });
    const r = rankJobs(runs);
    expect(r.jobs.map((j) => [j.key, j.label, j.samples, j.medianMs, j.stoppedEarly])).toEqual([
      ["wf:test#windows", "test › windows", 2, 1_200_000, 1],
      ["wf:test#linux", "test › linux", 3, 300_000, 0],
      ["wf:build", "build", 3, 100_000, 0],
      ["wf:lint", "build", 3, 20_000, 0],
    ]);
    expect(r.jobs[0]).toMatchObject({ minMs: 600_000, maxMs: 1_800_000, basis: "workflow-file" });
    expect(r.notes).toEqual([]);
  });

  it("without a workflow file, same-named jobs of one run are not measured, and name-only matches are not merged with workflow identities", () => {
    const yaml = `jobs:\n  build: { steps: [{ run: make }] }\n`;
    const withFile = side(run(1, "success"), [job("build", "success", 3600, 3700)], yaml);
    const noFile = side(run(2, "success"), [job("build", "success", 7200, 7300), job("build", "success", 7200, 7210), job("deploy", "success", 7300, 7400)]);
    const r = rankJobs([withFile, noFile]);
    // Both took 100 s: equal medians are ordered by key, so the order is the same for the same input.
    expect(r.jobs.map((j) => [j.key, j.basis, j.samples])).toEqual([
      ["name:deploy", "name", 1],
      ["wf:build", "workflow-file", 1],
    ]);
    expect(r.notes).toEqual([`In run 1002 (attempt 1), several jobs are named “build” and the workflow file is not available, so they are not measured.`]);
    const r2 = rankJobs([withFile, side(run(3, "success"), [job("build", "success", 10800, 10900)])]);
    expect(r2.jobs.map((j) => j.key)).toEqual(["name:build", "wf:build"]);
    expect(r2.notes[0]).toMatch(/listed by workflow identity and by name only/);
  });

  it("a successful job without timestamps is untimed, not zero", () => {
    const r = rankJobs([side(run(1, "success"), [job("build", "success", null, null)]), timed(2, 30)]);
    expect(r.jobs[0]).toMatchObject({ key: "name:build", samples: 1, medianMs: 30_000, untimed: 1 });
  });

  it("baseline: the median of earlier successful runs, robust to an outlier, reported as measured", () => {
    const history = [timed(1, 100), timed(2, 110), timed(3, 90), timed(4, 3000), timed(5, 105), side(run(6, "failure"), [job("build", "failure", 21600, 21610)])];
    const later = timed(9, 10);
    const b = compareToBaseline(timed(7, 150), [...history, later]);
    expect(b).toMatchObject({ kind: "measured", ms: 150_000, samples: 5, medianMs: 105_000, minMs: 90_000, maxMs: 3_000_000, deltaMs: 45_000, faster: 4, slower: 1 });
    expect((b as { ratio: number }).ratio).toBeCloseTo(150 / 105);
    expect((b as { caveats: string[] }).caveats).toEqual(["Durations are measured, not explained: a commit between the runs is not shown to be the cause of a change."]);
  });

  it("baseline: too few samples, an unsuccessful or unmeasurable run, and zero-duration baselines are explicit", () => {
    expect(compareToBaseline(timed(5, 100), [timed(1, 100), timed(2, 100)])).toEqual({
      kind: "insufficient",
      samples: 2,
      needed: 5,
      why: "2 earlier successful runs of this workflow with a measurable duration; 5 are needed for a baseline.",
    });
    expect(compareToBaseline(timed(5, 100), [timed(1, 100)], { minSamples: 1 })).toMatchObject({ kind: "measured", samples: 1 });
    expect(compareToBaseline(side(run(5, "cancelled"), [job("build", "cancelled", 18000, 18010)]), [timed(1, 100)])).toMatchObject({
      kind: "not-comparable",
      why: expect.stringContaining("did not succeed (cancelled)"),
    });
    expect(compareToBaseline(side(run(5, "success"), [job("build", "success", null, null)]), [])).toEqual({
      kind: "not-comparable",
      why: "This run has no measurable duration (missing timestamps).",
    });
    const zero = compareToBaseline(timed(5, 0), [timed(1, 0), timed(2, 0)], { minSamples: 2 });
    expect(zero).toMatchObject({ kind: "measured", ms: 0, medianMs: 0, deltaMs: 0, faster: 0, slower: 0 });
    expect(zero).not.toHaveProperty("ratio");
  });

  it("baseline: notes other branches and events instead of hiding them", () => {
    const b = compareToBaseline(timed(5, 100), [timed(1, 100, { head_branch: "feature" }), timed(2, 100, { event: "pull_request" })], { minSamples: 2 });
    expect((b as { caveats: string[] }).caveats.slice(0, 2)).toEqual(["The baseline includes runs on other branches.", "The baseline includes runs triggered by other events."]);
  });

  it("outcomes: counted per run attempt among runs of the same workflow, with the sample count", () => {
    const failed = side(run(2, "failure"), [job("build", "failure", 7200, 7230)]);
    const timedOut = side(run(3, "timed_out"), [job("build", "timed_out", 10800, 10900)]);
    const cancelled = side(run(4, "cancelled"), [job("build", "cancelled", null, null)]);
    const running = side(run(6, null as unknown as string, { status: "in_progress" }), [job("build", "success", 21600, 21610, { status: "in_progress", completed_at: null })]);
    const other = timed(7, 10, { workflow_id: 8, path: ".github/workflows/other.yml" });
    expect(outcomes([timed(1, 40), failed, timedOut, cancelled, timed(5, 50), running, other, timed(1, 40)])).toEqual({
      runs: 6,
      succeeded: 2,
      failed: 2,
      cancelled: 1,
      "in progress": 1,
      other: 0,
    });
    expect(outcomes([])).toEqual({ runs: 0, succeeded: 0, failed: 0, cancelled: 0, "in progress": 0, other: 0 });
  });

  it("chart series: oldest first, unmeasured runs keep their slot with a reason and no height, never zero", () => {
    const untimed = side(run(3, "success"), [job("build", "success", null, null)]);
    const running = side(run(4, null as unknown as string, { status: "in_progress" }), [job("build", "success", 14400, 14410, { status: "in_progress", completed_at: null })]);
    const failed = side(run(2, "failure"), [job("build", "failure", 7200, 7230)]);
    const c = chartSeries(durationTrend([timed(5, 50), running, untimed, failed, timed(1, 40)]));
    expect(c.points.map((p) => [p.index, p.runNumber, p.outcome, p.duration])).toEqual([
      [0, 1, "succeeded", { ms: 40_000 }],
      [1, 2, "failed", { ms: 30_000 }],
      [2, 3, "succeeded", { unavailable: "missing timestamps" }],
      [3, 4, "in progress", { unavailable: "in progress" }],
      [4, 5, "succeeded", { ms: 50_000 }],
    ]);
    expect(c).toMatchObject({ measured: 3, maxMs: 50_000 });
    expect(chartSeries(durationTrend([untimed]))).toEqual({ points: [expect.objectContaining({ runNumber: 3 })], measured: 0 });
  });
});
