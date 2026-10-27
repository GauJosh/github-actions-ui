// Retry evidence within one run (SYNTHETIC runs, attempts and jobs).
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildRunGraph } from "../graph/build";
import { readWorkflowDefinition, type WorkflowDefinition } from "../graph/workflow-definition";
import type { Job, Run } from "../types";
import type { HistoryRun } from "./history";
import { RECOVERY_CAVEAT, retryEvidence, type AttemptJobs, type HistoryInput, type RetryInput } from "./retry-evidence";

const RUN = 700;
const at = (m: number) => `2026-10-27T10:${String(m).padStart(2, "0")}:00Z`;
const run = (attempt: number, extra: Partial<Run> = {}): Run =>
  ({ id: RUN, name: "ci", display_title: "ci", status: "completed", conclusion: "failure", run_attempt: attempt, head_branch: "main", head_sha: "a".repeat(40), html_url: "", event: "push", path: ".github/workflows/ci.yml", workflow_id: 7, ...extra }) as Run;
const job = (id: number, name: string, conclusion: string | null, runAttempt: number | undefined, extra: Partial<Job> = {}): Job => ({
  id,
  name,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  started_at: at(id % 60),
  completed_at: conclusion === null ? null : at((id + 1) % 60),
  html_url: null,
  ...(runAttempt !== undefined && { run_attempt: runAttempt }),
  ...extra,
});

const WORKFLOW = `
jobs:
  build: { steps: [{ run: make }] }
  test:
    name: unit (\${{ matrix.node }})
    needs: build
    strategy: { matrix: { node: [18, 20] } }
    steps: [{ run: test }]
`;
const definition = readWorkflowDefinition(parse(WORKFLOW)) as WorkflowDefinition;
/** An attempt with the workflow file (workflow identity), or without it (`file: false`, matched by name). */
const attempt = (n: number, jobs: Job[], file = true): AttemptJobs => ({
  attempt: n,
  run: run(n),
  jobs,
  graph: file ? buildRunGraph(jobs, definition, { file: { path: ".github/workflows/ci.yml", revision: "a".repeat(40) } }) : buildRunGraph(jobs, null, { unavailableReason: "no file" }),
});
const input = (latestAttempt: number, attempts: AttemptJobs[], unread: RetryInput["unread"] = []): RetryInput => ({ runId: RUN, latestAttempt, attempts, unread });
const byName = (e: ReturnType<typeof retryEvidence>, name: string) => e.jobs.filter((j) => j.observations.some((o) => o.name === name));
const kinds = (e: ReturnType<typeof retryEvidence>) => e.jobs.flatMap((j) => j.findings.map((f) => f.kind));

describe("retry evidence within one run", () => {
  it("a job that failed in attempt 1 and ran again and succeeded in attempt 2 recovered on retry", () => {
    const e = retryEvidence(
      input(2, [
        attempt(1, [job(11, "build", "success", 1), job(12, "unit (18)", "failure", 1), job(13, "unit (20)", "success", 1)]),
        // "Re-run failed jobs": the others are listed as run in attempt 1.
        attempt(2, [job(11, "build", "success", 1), job(22, "unit (18)", "success", 2), job(13, "unit (20)", "success", 1)]),
      ]),
    );
    const [unit18] = byName(e, "unit (18)");
    expect(unit18!.identity).toMatchObject({ basis: "workflow-file", label: "test › 18" });
    expect(unit18!.findings).toEqual([
      {
        kind: "recovered on retry",
        failed: { runId: RUN, jobId: 12, name: "unit (18)", listedInAttempt: 1, ranInAttempt: 1, status: "completed", conclusion: "failure", outcome: "failed", completedAt: at(13) },
        succeeded: { runId: RUN, jobId: 22, name: "unit (18)", listedInAttempt: 2, ranInAttempt: 2, status: "completed", conclusion: "success", outcome: "succeeded", completedAt: at(23) },
        caveat: RECOVERY_CAVEAT,
      },
    ]);
    expect(RECOVERY_CAVEAT).toMatch(/does not by itself show that the job is flaky, or why it failed/);
    expect(kinds(e)).toEqual(["recovered on retry"]);
    expect(e).toMatchObject({ attemptsRead: [1, 2], attemptsMissing: [], notes: [] });
  });

  it("a job carried over into a later attempt is observed once and is not a recovery", () => {
    const e = retryEvidence(
      input(2, [
        attempt(1, [job(11, "build", "failure", 1), job(12, "unit (18)", "success", 1)]),
        // unit (18) was not re-run: the same job, listed again with run_attempt 1.
        attempt(2, [job(21, "build", "failure", 2), job(12, "unit (18)", "success", 1)]),
      ]),
    );
    const [unit18] = byName(e, "unit (18)");
    expect(unit18!.observations).toHaveLength(1);
    expect(unit18!.observations[0]).toMatchObject({ jobId: 12, listedInAttempt: 1, ranInAttempt: 1 });
    expect(unit18!.findings).toEqual([]);
    expect(byName(e, "build")[0]!.findings).toEqual([{ kind: "failed in every attempt observed", attempts: [1, 2] }]);
  });

  it("a success listed in attempt 2 but reported as run in attempt 1 is not a recovery", () => {
    // Attempt 1 is read without the carried success (e.g. listed only in the later attempt): it is placed in attempt 1,
    // beside the failure there, so the identity no longer names one job per attempt.
    const e = retryEvidence(input(2, [attempt(1, [job(12, "unit (18)", "failure", 1)]), attempt(2, [job(25, "unit (18)", "success", 1)])]));
    const [unit18] = byName(e, "unit (18)");
    expect(unit18!.observations.map((o) => [o.jobId, o.listedInAttempt, o.ranInAttempt])).toEqual([
      [12, 1, 1],
      [25, 2, 1],
    ]);
    expect(unit18!.findings).toEqual([{ kind: "insufficient evidence", reasons: ["More than one job with this identity ran in attempt 1, so they cannot be told apart."] }]);
  });

  it("the same job failing in attempts 1 and 2 failed in every attempt observed, which is not recurrence across runs", () => {
    const e = retryEvidence(input(2, [attempt(1, [job(12, "unit (18)", "failure", 1)]), attempt(2, [job(22, "unit (18)", "timed_out", 2)])]));
    expect(e.jobs).toHaveLength(1);
    expect(e.jobs[0]!.findings).toEqual([{ kind: "failed in every attempt observed", attempts: [1, 2] }]);
    expect(e.jobs[0]!.observations.map((o) => [o.conclusion, o.outcome])).toEqual([
      ["failure", "failed"],
      ["timed_out", "failed"],
    ]);
    expect(JSON.stringify(e)).not.toMatch(/recurr|flaky/i);
  });

  it("duplicate job names without the workflow file are not paired; no recovery is claimed", () => {
    const e = retryEvidence(
      input(2, [attempt(1, [job(11, "test", "failure", 1), job(12, "test", "success", 1)], false), attempt(2, [job(21, "test", "success", 2)], false)]),
    );
    expect(e.jobs).toHaveLength(1);
    expect(e.jobs[0]!.identity).toEqual({ key: "name:test", basis: "name", label: "test" });
    expect(e.jobs[0]!.findings).toEqual([{ kind: "insufficient evidence", reasons: ["In attempt 1, more than one job has this identity, so its jobs cannot be told apart between attempts."] }]);
    expect(kinds(e)).not.toContain("recovered on retry");
  });

  it("similarly named but distinct jobs are never matched", () => {
    const e = retryEvidence(input(2, [attempt(1, [job(11, "unit-test", "failure", 1)], false), attempt(2, [job(21, "unit-tests", "success", 2), job(22, "Unit-test", "success", 2)], false)]));
    expect(e.jobs.map((j) => j.identity.key)).toEqual(["name:Unit-test", "name:unit-test", "name:unit-tests"]);
    expect(kinds(e)).toEqual([]);
    expect(byName(e, "unit-test")[0]!.notes).toEqual([
      "Matched between attempts by its exact name only: the workflow file was not available.",
      "It ran in attempt 1 only, so there is no retry to compare.",
    ]);
  });

  it("a job matched by name without the workflow file can recover; the name-only basis is said", () => {
    const e = retryEvidence(input(2, [attempt(1, [job(11, "lint", "failure", 1)], false), attempt(2, [job(21, "lint", "success", 2)], false)]));
    expect(e.jobs[0]!.findings.map((f) => f.kind)).toEqual(["recovered on retry"]);
    expect(e.jobs[0]!.notes).toEqual(["Matched between attempts by its exact name only: the workflow file was not available."]);
  });

  it("jobs identified by the workflow file in one attempt and by name only in another are not matched", () => {
    const e = retryEvidence(input(2, [attempt(1, [job(11, "build", "failure", 1)]), attempt(2, [job(21, "build", "success", 2)], false)]));
    expect(e.jobs.map((j) => j.identity.key)).toEqual(["name:build", "wf:build"]);
    expect(kinds(e)).toEqual([]);
    expect(e.notes).toEqual(["“build” is identified by the workflow file in some attempts and by name only in others, so those jobs are not matched between attempts."]);
  });

  it("a failure followed by a cancelled or skipped attempt is not a recovery", () => {
    for (const conclusion of ["cancelled", "skipped"]) {
      const e = retryEvidence(input(2, [attempt(1, [job(12, "unit (18)", "failure", 1)]), attempt(2, [job(22, "unit (18)", conclusion, 2)])]));
      expect(e.jobs[0]!.findings).toEqual([{ kind: "insufficient evidence", reasons: [`In attempt 2 it ended ${conclusion}, which is neither a failure nor a success.`] }]);
      expect(e.jobs[0]!.observations[1]).toMatchObject({ conclusion, outcome: "other" });
    }
  });

  it("a job still running in the later attempt is neither a failure nor a success", () => {
    const e = retryEvidence(input(2, [attempt(1, [job(12, "unit (18)", "failure", 1)]), attempt(2, [job(22, "unit (18)", null, 2)])]));
    expect(e.jobs[0]!.observations[1]).toMatchObject({ status: "in_progress", conclusion: null, outcome: "other" });
    expect(e.jobs[0]!.observations[1]).not.toHaveProperty("completedAt");
    expect(e.jobs[0]!.findings).toEqual([{ kind: "insufficient evidence", reasons: ["In attempt 2 it ended in_progress, which is neither a failure nor a success."] }]);
  });

  it("an attempt that could not be read is reported as unknown, never as a success", () => {
    const e = retryEvidence(input(3, [attempt(1, [job(12, "unit (18)", "failure", 1)])], [{ attempt: 2, why: "GitHub returned attempt 1" }]));
    expect(e.attemptsRead).toEqual([1]);
    expect(e.attemptsMissing).toEqual([
      { attempt: 2, why: "GitHub returned attempt 1" },
      { attempt: 3, why: "it was not loaded" },
    ]);
    expect(e.notes).toEqual(["Not read: attempt 2 (GitHub returned attempt 1), attempt 3 (it was not loaded). What happened in them is unknown, not a success."]);
    expect(kinds(e)).toEqual([]);
    expect(e.jobs[0]!.observations).toHaveLength(1);
  });

  it("an attempt whose data is of another attempt, or supplied twice, is not used", () => {
    const wrong = { ...attempt(2, [job(22, "unit (18)", "success", 2)]), run: run(1) };
    const e = retryEvidence(input(3, [attempt(1, [job(12, "unit (18)", "failure", 1)]), wrong, attempt(3, [job(32, "unit (18)", "success", 3)]), attempt(3, [job(33, "unit (18)", "failure", 3)])]));
    expect(e.attemptsRead).toEqual([1]);
    expect(e.attemptsMissing).toEqual([
      { attempt: 2, why: "GitHub's data for it is of another run or attempt" },
      { attempt: 3, why: "it was supplied more than once" },
    ]);
    expect(kinds(e)).toEqual([]);
  });

  it("with one attempt there is no retry finding", () => {
    const e = retryEvidence(input(1, [attempt(1, [job(11, "build", "success", 1), job(12, "unit (18)", "failure", 1)])]));
    expect(kinds(e)).toEqual([]);
    expect(e).toMatchObject({ attemptsRead: [1], attemptsMissing: [], notes: [] });
    expect(byName(e, "unit (18)")[0]!.notes).toEqual(["It ran in attempt 1 only, so there is no retry to compare."]);
  });

  it("a success whose attempt GitHub's data does not establish is not a recovery", () => {
    for (const runAttempt of [undefined, 3]) {
      const e = retryEvidence(input(2, [attempt(1, [job(12, "unit (18)", "failure", 1)]), attempt(2, [job(22, "unit (18)", "success", runAttempt)])]));
      expect(e.jobs[0]!.observations[1]).toMatchObject({ jobId: 22, listedInAttempt: 2, ranInAttempt: null });
      expect(e.jobs[0]!.findings).toEqual([{ kind: "insufficient evidence", reasons: ["Some of its jobs cannot be placed in an attempt, so a retry cannot be established."] }]);
      expect(e.notes).toContain("GitHub's data does not say which attempt 1 job ran in, so it is not used for findings.");
    }
  });

  it("a job without run_attempt listed in attempt 1 ran in attempt 1", () => {
    const e = retryEvidence(input(2, [attempt(1, [job(12, "unit (18)", "failure", undefined)]), attempt(2, [job(22, "unit (18)", "success", 2)])]));
    expect(e.jobs[0]!.findings.map((f) => f.kind)).toEqual(["recovered on retry"]);
  });

  it("success then failure is not a recovery; failure, success, failure is, and the later failure is noted", () => {
    const late = retryEvidence(input(2, [attempt(1, [job(12, "unit (18)", "success", 1)]), attempt(2, [job(22, "unit (18)", "failure", 2)])]));
    expect(late.jobs[0]!.findings).toEqual([{ kind: "insufficient evidence", reasons: ["It succeeded before it failed in attempt 2; no later attempt shows it succeeding."] }]);

    const again = retryEvidence(
      input(3, [attempt(1, [job(12, "unit (18)", "failure", 1)]), attempt(2, [job(22, "unit (18)", "success", 2)]), attempt(3, [job(32, "unit (18)", "failure", 3)])]),
    );
    const [f] = again.jobs[0]!.findings;
    expect(f).toMatchObject({ kind: "recovered on retry", failed: { jobId: 12 }, succeeded: { jobId: 22 } });
    expect(again.jobs[0]!.notes).toEqual(["It failed again in attempt 3."]);
  });

  it("failure, startup_failure and timed_out are failed outcomes; each keeps GitHub's conclusion", () => {
    for (const conclusion of ["failure", "startup_failure", "timed_out"]) {
      const e = retryEvidence(input(2, [attempt(1, [job(12, "unit (18)", conclusion, 1)]), attempt(2, [job(22, "unit (18)", "success", 2)])]));
      expect(e.jobs[0]!.observations[0]).toMatchObject({ status: "completed", conclusion, outcome: "failed" });
      expect(e.jobs[0]!.findings[0]).toMatchObject({ kind: "recovered on retry", failed: { jobId: 12, conclusion, outcome: "failed" }, succeeded: { jobId: 22, conclusion: "success" } });
    }
    // Two startup failures are a failure in every attempt observed.
    const both = retryEvidence(input(2, [attempt(1, [job(12, "unit (18)", "startup_failure", 1)]), attempt(2, [job(22, "unit (18)", "startup_failure", 2)])]));
    expect(both.jobs[0]!.findings).toEqual([{ kind: "failed in every attempt observed", attempts: [1, 2] }]);
    expect(both.jobs[0]!.observations.map((o) => [o.conclusion, o.outcome])).toEqual([
      ["startup_failure", "failed"],
      ["startup_failure", "failed"],
    ]);
  });

  it("the failure paired with a recovery is the latest one before it; startup_failure is kept as reported", () => {
    const e = retryEvidence(
      input(3, [attempt(1, [job(12, "unit (18)", "failure", 1)]), attempt(2, [job(22, "unit (18)", "startup_failure", 2)]), attempt(3, [job(32, "unit (18)", "success", 3)])]),
    );
    expect(e.jobs[0]!.findings[0]).toMatchObject({ kind: "recovered on retry", failed: { jobId: 22, conclusion: "startup_failure", outcome: "failed" }, succeeded: { jobId: 32 } });
  });

  it("the result is the same for any order of attempts and jobs", () => {
    const attempts = [
      attempt(1, [job(11, "build", "success", 1), job(12, "unit (18)", "failure", 1), job(13, "unit (20)", "failure", 1), job(14, "dup", "failure", 1), job(15, "dup", "success", 1)]),
      attempt(2, [job(11, "build", "success", 1), job(22, "unit (18)", "success", 2), job(23, "unit (20)", "failure", 2), job(24, "dup", "success", 2)]),
      attempt(3, [job(11, "build", "success", 1), job(32, "unit (18)", "success", 3), job(33, "unit (20)", "cancelled", 3), job(34, "dup", "failure", 3)]),
    ];
    const reversed = [...attempts].reverse().map((a) => ({ ...a, jobs: [...a.jobs].reverse() }));
    const unread = [
      { attempt: 4, why: "request failed" },
      { attempt: 5, why: "request failed" },
    ];
    const a = retryEvidence(input(5, attempts, unread));
    const b = retryEvidence(input(5, reversed, [...unread].reverse()));
    expect(b).toEqual(a);
    expect(kinds(a)).toEqual(["insufficient evidence", "recovered on retry", "insufficient evidence"]);
  });
});

describe("job outcomes across runs", () => {
  /** An earlier run at its latest attempt, as loadHistory returns it (no workflow file unless `file`). */
  const hist = (id: number, jobs: Job[], extra: Partial<Run> = {}, file?: string): HistoryRun => {
    const r = { ...run(1, { conclusion: "success", run_started_at: `2026-10-2${id % 7}T09:00:00Z`, ...extra }), id, run_number: id - 600 } as Run;
    const def = file ? (readWorkflowDefinition(parse(file)) as WorkflowDefinition) : null;
    return { run: r, attempt: r.run_attempt, jobs, graph: def ? buildRunGraph(jobs, def, { file: { path: r.path!, revision: r.head_sha } }) : null };
  };
  const withHistory = (i: RetryInput, runs: HistoryRun[], failed: HistoryInput["failed"] = []): RetryInput => ({ ...i, history: { runs, failed, listed: runs.length + failed.length, limit: 20 } });
  const cross = (e: ReturnType<typeof retryEvidence>, name: string) => e.acrossRuns.jobs.filter((j) => j.observations.some((o) => o.name === name) || j.identity.label === name);
  const crossKinds = (e: ReturnType<typeof retryEvidence>) => e.acrossRuns.jobs.flatMap((j) => j.findings.map((f) => `${j.identity.label}: ${f.kind}`));
  const target = (...attempts: AttemptJobs[]) => input(attempts.length, attempts);

  it("a job that failed in two distinct earlier runs is a recurring failure; run and attempt ids and conclusions are kept", () => {
    const e = retryEvidence(withHistory(target(attempt(1, [job(12, "lint", "success", 1)], false)), [hist(601, [job(6011, "lint", "failure", 1)]), hist(602, [job(6021, "lint", "timed_out", 1)])]));
    const [lint] = cross(e, "lint");
    expect(lint!.identity).toEqual({ key: "name:lint", basis: "name", label: "lint" });
    expect(lint!.observations.map((o) => [o.runId, o.attempt, o.jobId, o.conclusion, o.outcome, o.target])).toEqual([
      [601, 1, 6011, "failure", "failed", false],
      [602, 1, 6021, "timed_out", "failed", false],
      [RUN, 1, 12, "success", "succeeded", true],
    ]);
    expect(lint!.counts).toEqual({ failed: 2, succeeded: 1, other: 0 });
    expect(lint!.findings[0]).toEqual({ kind: "recurring failure", failedRunIds: [601, 602], runsObserved: 3, runsCompared: 3 });
    expect(e.acrossRuns).toMatchObject({ history: "loaded", basis: "name", listed: 2, limit: 20, runsCompared: [601, 602, RUN], unread: [], excluded: [] });
    expect(e.acrossRuns.notes).toContain("Results describe the 2 earlier runs compared (GitHub listed 2; at most 20 are loaded), not every run of this workflow.");
    expect(JSON.stringify(e.acrossRuns)).not.toMatch(/flaky/i);
  });

  it("two failed attempts of the run under investigation count as one failed run", () => {
    const e = retryEvidence(withHistory(target(attempt(1, [job(12, "lint", "failure", 1)], false), attempt(2, [job(22, "lint", "failure", 2)], false)), [hist(601, [job(6011, "lint", "failure", 1)])]));
    const [lint] = cross(e, "lint");
    expect(lint!.observations.map((o) => [o.runId, o.attempt, o.jobId])).toEqual([
      [601, 1, 6011],
      [RUN, 2, 22],
    ]);
    expect(lint!.findings).toEqual([{ kind: "recurring failure", failedRunIds: [601, RUN], runsObserved: 2, runsCompared: 2 }]);
    // Within the run, unchanged: a failure in every attempt observed.
    expect(e.jobs[0]!.findings).toEqual([{ kind: "failed in every attempt observed", attempts: [1, 2] }]);
  });

  it("a run that failed and then succeeded on its latest attempt counts as a success across runs", () => {
    const e = retryEvidence(withHistory(target(attempt(1, [job(12, "lint", "failure", 1)], false), attempt(2, [job(22, "lint", "success", 2)], false)), [hist(601, [job(6011, "lint", "failure", 1)])]));
    const [lint] = cross(e, "lint");
    expect(lint!.observations.find((o) => o.target)).toMatchObject({ attempt: 2, jobId: 22, outcome: "succeeded" });
    expect(lint!.findings.map((f) => f.kind)).toEqual(["mixed outcomes"]);
    expect(e.jobs[0]!.findings.map((f) => f.kind)).toEqual(["recovered on retry"]);
  });

  it("a job carried into the latest attempt gives the run its outcome from the attempt it ran in", () => {
    const e = retryEvidence(
      withHistory(target(attempt(1, [job(11, "build", "failure", 1), job(12, "lint", "failure", 1)], false), attempt(2, [job(21, "build", "success", 2), job(12, "lint", "failure", 1)], false)), [
        hist(601, [job(6012, "lint", "failure", 1)]),
      ]),
    );
    expect(cross(e, "lint")[0]!.observations.find((o) => o.target)).toMatchObject({ attempt: 2, jobId: 12, conclusion: "failure" });
    expect(cross(e, "lint")[0]!.findings[0]).toMatchObject({ kind: "recurring failure", failedRunIds: [601, RUN] });
  });

  it("a run whose latest attempt has not completed, or was not read, is not counted", () => {
    const running = { ...attempt(2, [job(22, "lint", null, 2)], false), run: run(2, { status: "in_progress", conclusion: null }) };
    const e = retryEvidence(withHistory(input(2, [attempt(1, [job(12, "lint", "failure", 1)], false), running]), [hist(601, [job(6011, "lint", "failure", 1)])]));
    expect(e.acrossRuns.target).toEqual({ runId: RUN, attempt: 2, included: false, why: "its latest attempt (2) has not completed" });
    expect(e.acrossRuns.runsCompared).toEqual([601]);
    expect(cross(e, "lint")[0]!.observations.map((o) => o.runId)).toEqual([601]);
    expect(e.acrossRuns.notes).toContain("This run is not counted across runs: its latest attempt (2) has not completed.");

    const unreadLatest = retryEvidence(withHistory(input(2, [attempt(1, [job(12, "lint", "failure", 1)], false)], [{ attempt: 2, why: "request failed" }]), [hist(601, [job(6011, "lint", "failure", 1)])]));
    expect(unreadLatest.acrossRuns.target).toEqual({ runId: RUN, attempt: 2, included: false, why: "its latest attempt (2) was not read" });
    // Attempt 1's failure does not stand in for the run.
    expect(cross(unreadLatest, "lint")[0]!.counts).toEqual({ failed: 1, succeeded: 0, other: 0 });
  });

  it("failure in one run and success in another are mixed outcomes; sameCommit says whether one commit has both", () => {
    const same = retryEvidence(withHistory(target(attempt(1, [job(12, "lint", "failure", 1)], false)), [hist(601, [job(6011, "lint", "success", 1)])]));
    expect(cross(same, "lint")[0]!.findings).toEqual([{ kind: "mixed outcomes", failedRunIds: [RUN], succeededRunIds: [601], sameCommit: true, commitsWithBoth: ["a".repeat(40)] }]);

    const other = retryEvidence(withHistory(target(attempt(1, [job(12, "lint", "failure", 1)], false)), [hist(601, [job(6011, "lint", "success", 1)], { head_sha: "b".repeat(40) })]));
    expect(cross(other, "lint")[0]!.findings).toEqual([{ kind: "mixed outcomes", failedRunIds: [RUN], succeededRunIds: [601], sameCommit: false, commitsWithBoth: [] }]);
  });

  it("duplicate names without the workflow file are not matched across runs, and give no recurrence", () => {
    const e = retryEvidence(
      withHistory(target(attempt(1, [job(12, "test", "failure", 1)], false)), [hist(601, [job(6011, "test", "failure", 1), job(6012, "test", "success", 1)]), hist(602, [job(6021, "test", "failure", 1)])]),
    );
    const [t] = cross(e, "test");
    expect(t!.ambiguousIn).toEqual([601]);
    expect(t!.observations.map((o) => o.runId)).toEqual([602, RUN]);
    expect(t!.findings).toEqual([{ kind: "insufficient evidence", reasons: ["In run 601, more than one job has this identity, so it cannot be matched safely across runs."] }]);
  });

  it("without the workflow file for every run, all runs are matched by name only; workflow identity is never mixed in", () => {
    // This run has its workflow file; the history has none, as loadHistory returns it.
    const e = retryEvidence(withHistory(target(attempt(1, [job(12, "unit (18)", "failure", 1)])), [hist(601, [job(6011, "unit (18)", "failure", 1)])]));
    expect(e.acrossRuns.basis).toBe("name");
    expect(e.acrossRuns.jobs.map((j) => j.identity)).toEqual([{ key: "name:unit (18)", basis: "name", label: "unit (18)" }]);
    expect(e.acrossRuns.jobs[0]!.notes).toEqual(["Matched by name only: the workflow file was not available for every run compared."]);
    expect(e.acrossRuns.notes).toContain("The workflow file was not available for every run compared, so jobs are matched across runs by exact name only.");
    // Within the run, the workflow identity is still used.
    expect(e.jobs[0]!.identity.basis).toBe("workflow-file");
  });

  it("with the workflow file for every run, jobs match by workflow identity; a job only matched by name in one run stays apart", () => {
    const noBuild = `
jobs:
  test:
    name: unit (\${{ matrix.node }})
    strategy: { matrix: { node: [18, 20] } }
    steps: [{ run: test }]
`;
    const e = retryEvidence(
      withHistory(target(attempt(1, [job(11, "build", "failure", 1), job(12, "unit (18)", "failure", 1)])), [
        hist(601, [job(6011, "build", "failure", 1), job(6012, "unit (18)", "failure", 1)], {}, WORKFLOW),
        hist(602, [job(6021, "build", "failure", 1), job(6022, "unit (18)", "success", 1)], {}, noBuild),
      ]),
    );
    expect(e.acrossRuns.basis).toBe("workflow-file");
    expect(e.acrossRuns.jobs.map((j) => [j.identity.key, j.identity.basis, j.observations.map((o) => o.runId)])).toEqual([
      ["name:build", "name", [602]],
      ["wf:build", "workflow-file", [601, RUN]],
      ["wf:test#18", "workflow-file", [601, 602, RUN]],
    ]);
    expect(e.acrossRuns.notes).toContain("“build” is identified by the workflow file in some runs and by name only in others, so those jobs are not matched across runs.");
    expect(crossKinds(e)).toEqual(["build: insufficient evidence", "build: recurring failure", "test › 18: recurring failure", "test › 18: mixed outcomes"]);
  });

  it("runs that could not be read are listed and never counted", () => {
    const e = retryEvidence(withHistory(target(attempt(1, [job(12, "lint", "failure", 1)], false)), [hist(601, [job(6011, "lint", "cancelled", 1)])], [{ runId: 603, attempt: 2, why: "request failed" }]));
    expect(e.acrossRuns.unread).toEqual([{ runId: 603, attempt: 2, why: "request failed" }]);
    expect(e.acrossRuns.runsCompared).toEqual([601, RUN]);
    expect(e.acrossRuns.notes).toContain("1 earlier run could not be read (run 603): its outcome is unknown and not counted.");
    expect(cross(e, "lint")[0]!.counts).toEqual({ failed: 1, succeeded: 0, other: 1 });
    expect(cross(e, "lint")[0]!.findings).toEqual([
      {
        kind: "insufficient evidence",
        reasons: ["It failed in 1 of the 2 runs it was observed in.", "1 earlier run could not be read; its outcome is unknown.", "In run 601 it ended cancelled, which is neither a failure nor a success."],
      },
    ]);
  });

  it("history not loaded is not the same as history loaded with no earlier runs", () => {
    const notLoaded = retryEvidence(target(attempt(1, [job(12, "lint", "failure", 1)], false)));
    expect(notLoaded.acrossRuns).toMatchObject({ history: "not loaded", runsCompared: [RUN], unread: [], excluded: [] });
    expect(notLoaded.acrossRuns).not.toHaveProperty("listed");
    expect(notLoaded.acrossRuns.notes).toEqual(["History was not loaded, so outcomes in other runs of this workflow are unknown."]);
    expect(notLoaded.acrossRuns.jobs[0]!.findings).toEqual([{ kind: "insufficient evidence", reasons: ["History was not loaded, so other runs are unknown."] }]);

    const empty = retryEvidence({ ...target(attempt(1, [job(12, "lint", "failure", 1)], false)), history: { runs: [], failed: [], listed: 0, limit: 20 } });
    expect(empty.acrossRuns).toMatchObject({ history: "loaded", listed: 0, limit: 20, runsCompared: [RUN] });
    expect(empty.acrossRuns.notes).toEqual(["History was loaded and holds no earlier runs of this workflow."]);
    expect(empty.acrossRuns.jobs[0]!.findings).toEqual([{ kind: "insufficient evidence", reasons: ["No earlier run of this workflow was compared."] }]);
  });

  it("branches and events of the runs compared stay visible", () => {
    const e = retryEvidence(
      withHistory(target(attempt(1, [job(12, "lint", "failure", 1)], false)), [hist(601, [job(6011, "lint", "failure", 1)], { head_branch: "feature/x", event: "pull_request", head_sha: "c".repeat(40) })]),
    );
    expect(cross(e, "lint")[0]!.observations.map((o) => [o.runId, o.branch, o.event, o.commit.slice(0, 1)])).toEqual([
      [601, "feature/x", "pull_request", "c"],
      [RUN, "main", "push", "a"],
    ]);
    expect(e.acrossRuns.notes).toEqual(
      expect.arrayContaining(["The runs compared are on 2 branches (feature/x, main); findings are not limited to one branch.", "The runs compared were triggered by 2 events (pull_request, push)."]),
    );
  });

  it("other workflows, this run itself, duplicates, earlier attempts and unfinished runs are excluded with a reason", () => {
    const lint = (id: number) => [job(id * 10 + 1, "lint", "failure", 1)];
    const e = retryEvidence(
      withHistory(target(attempt(1, [job(12, "lint", "failure", 1)], false)), [
        hist(601, lint(601), { workflow_id: 8, path: ".github/workflows/other.yml" }),
        hist(RUN, lint(RUN)),
        hist(603, lint(603)),
        hist(603, lint(603)),
        { ...hist(604, lint(604), { run_attempt: 2 }), attempt: 1 },
        hist(605, lint(605), { status: "in_progress", conclusion: null }),
      ]),
    );
    expect(e.acrossRuns.excluded).toEqual([
      { runId: 601, attempt: 1, why: "a different workflow" },
      { runId: 603, attempt: 1, why: "the run was supplied more than once" },
      { runId: 604, attempt: 1, why: "not the run's latest attempt (attempt 1 of 2)" },
      { runId: 605, attempt: 1, why: "the run has not completed" },
      { runId: RUN, attempt: 1, why: "the run under investigation (its own attempts are used)" },
    ]);
    expect(e.acrossRuns.runsCompared).toEqual([RUN]);
  });

  it("cancelled, skipped and unfinished jobs are neither failures nor successes", () => {
    const e = retryEvidence(
      withHistory(target(attempt(1, [job(12, "lint", "failure", 1)], false)), [
        hist(601, [job(6011, "lint", "cancelled", 1)]),
        hist(602, [job(6021, "lint", "skipped", 1)]),
        hist(603, [job(6031, "lint", "neutral", 1)]),
        hist(604, [job(6041, "lint", null, 1)]),
      ]),
    );
    const [l] = cross(e, "lint");
    expect(l!.counts).toEqual({ failed: 1, succeeded: 0, other: 4 });
    expect(l!.findings).toHaveLength(1);
    expect(l!.findings[0]!.kind).toBe("insufficient evidence");
  });

  it("the result is the same for any order of runs, jobs and unread runs", () => {
    const runs = [
      hist(601, [job(6011, "lint", "failure", 1), job(6012, "dup", "failure", 1), job(6013, "dup", "success", 1)]),
      hist(602, [job(6021, "lint", "success", 1), job(6022, "dup", "failure", 1)], { head_sha: "b".repeat(40), head_branch: "dev" }),
      hist(603, [job(6031, "lint", "failure", 1)], { event: "schedule" }),
      hist(609, [job(6091, "lint", "failure", 1)], { workflow_id: 9 }),
    ];
    const failed = [
      { runId: 605, attempt: 1, why: "request failed" },
      { runId: 604, attempt: 3, why: "request failed" },
    ];
    const attempts = [attempt(1, [job(12, "lint", "failure", 1), job(13, "dup", "success", 1)], false), attempt(2, [job(22, "lint", "failure", 2), job(13, "dup", "success", 1)], false)];
    const a = retryEvidence(withHistory(input(2, attempts), runs, failed));
    const b = retryEvidence(withHistory(input(2, [...attempts].reverse()), [...runs].reverse().map((r) => ({ ...r, jobs: [...r.jobs].reverse() })), [...failed].reverse()));
    expect(b).toEqual(a);
    expect(crossKinds(a)).toEqual(["dup: insufficient evidence", "lint: recurring failure", "lint: mixed outcomes"]);
  });
});
