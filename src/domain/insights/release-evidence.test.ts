// Release and deployment evidence (SYNTHETIC repositories, commits, deployments, releases and artifacts).
import { describe, expect, it } from "vitest";
import type { DeploymentRecord } from "./deployments";
import { environmentJoin, linkedRun, releaseEvidence, type EvidenceInput, type GitHubDeployment, type GitHubDeploymentStatus } from "./release-evidence";

const repo = { owner: "acme-synthetic", repo: "app" };
const C = "c".repeat(40);
const OTHER = "d".repeat(40);
const RUN = "https://github.com/acme-synthetic/app/actions/runs/500";
const run = (extra: Partial<EvidenceInput["run"]> = {}): EvidenceInput["run"] => ({ id: 500, head_sha: C, conclusion: "success", html_url: RUN, ...extra });
const dep = (id: number, extra: Partial<GitHubDeployment> = {}): GitHubDeployment => ({ id, sha: C, ref: "main", environment: "env-a", created_at: "2026-10-25T10:00:00Z", ...extra });
const status = (id: number, state: string, extra: Partial<GitHubDeploymentStatus> = {}): GitHubDeploymentStatus => ({ id, state, created_at: `2026-10-25T10:0${id % 10}:00Z`, ...extra });
const evidence = (deployments: EvidenceInput["deployments"], extra: Partial<EvidenceInput> = {}) => releaseEvidence({ repo, run: run(), deployments, ...extra });

describe("release and deployment evidence", () => {
  it("same commit and a status linking to this run: confirmed; same commit alone: tied to the commit, not the run", () => {
    const e = evidence([
      { deployment: dep(1), statuses: [status(1, "in_progress"), status(2, "success", { log_url: `${RUN}/job/9` })] },
      { deployment: dep(2, { environment: "env-b" }), statuses: [status(3, "success")] },
    ]);
    expect(e.deployments.map((d) => [d.id, d.environment, d.association, d.outcome, d.state])).toEqual([
      [1, "env-a", "confirmed", "succeeded", "success"],
      [2, "env-b", "same commit", "succeeded", "success"],
    ]);
    expect(e.deployments[1]!.basis[0]).toContain("another run or tool may have created it");
    expect(e.notes).toEqual([]);
  });

  it("a deployment of another commit is never a match, even when created at the same moment; one linking to this run is a conflict", () => {
    const e = evidence([
      { deployment: dep(1, { sha: OTHER }), statuses: [status(1, "success")] },
      { deployment: dep(2, { sha: OTHER }), statuses: [status(2, "success", { target_url: RUN })] },
    ]);
    expect(e.otherCommits).toBe(1);
    expect(e.deployments).toHaveLength(1);
    expect(e.deployments[0]).toMatchObject({ id: 2, association: "conflicting" });
    expect(e.deployments[0]!.basis[0]).toContain("not the run's ccccccc");
    expect(e.notes).toContain("The run succeeded, but GitHub lists no deployment of its commit: a successful run is not a deployment.");
  });

  it("outcome from the latest status, GitHub's state kept; missing or unloaded statuses are not guessed", () => {
    const outcomes = evidence([
      { deployment: dep(1), statuses: [status(1, "success"), status(2, "failure")] },
      { deployment: dep(2), statuses: [status(3, "error")] },
      { deployment: dep(3), statuses: [status(4, "queued")] },
      { deployment: dep(4), statuses: [status(5, "inactive")] },
      { deployment: dep(5), statuses: [] },
      { deployment: dep(6), statuses: null },
      { deployment: dep(7), statuses: [status(6, "something-new")] },
      { deployment: dep(8), statuses: [status(7, "waiting")] },
    ]);
    expect(outcomes.deployments.map((d) => [d.id, d.outcome, d.state])).toEqual([
      [1, "failed", "failure"],
      [2, "failed", "error"],
      [3, "pending", "queued"],
      [4, "inactive", "inactive"],
      [5, "no status", undefined],
      [6, "statuses not loaded", undefined],
      [7, "unrecognised status", "something-new"],
      [8, "waiting", "waiting"],
    ]);
    expect(outcomes.notes).toContain("Some deployments' statuses were not loaded or could not be read; their outcome is unknown.");
  });

  it("several deployments of one commit are all kept, and repeated environments are noted", () => {
    const e = evidence([
      { deployment: dep(1, { environment: "env-a" }), statuses: [status(1, "success")] },
      { deployment: dep(2, { environment: "env-a" }), statuses: [status(2, "failure")] },
      { deployment: dep(3, { environment: "env-c", production_environment: true }), statuses: [status(3, "success")] },
    ]);
    expect(e.deployments.map((d) => [d.environment, d.outcome])).toEqual([
      ["env-a", "succeeded"],
      ["env-a", "failed"],
      ["env-c", "succeeded"],
    ]);
    expect(e.deployments[2]!.production).toBe(true);
    expect(e.notes).toEqual(["2 deployments of this commit to env-a; each is listed with its own status."]);
  });

  it("missing metadata: no deployment SHA, no run commit, deployments not loaded", () => {
    const noSha = evidence([{ deployment: dep(1, { sha: null }), statuses: [status(1, "success")] }]);
    expect(noSha.deployments[0]).toMatchObject({ association: "unknown", basis: ["GitHub reported no full commit SHA for this deployment."] });
    const shortSha = evidence([{ deployment: dep(1, { sha: "ccccccc" }), statuses: [] }]);
    expect(shortSha.deployments[0]!.association).toBe("unknown");
    const noCommit = releaseEvidence({ repo, run: run({ head_sha: "" }), deployments: [{ deployment: dep(1), statuses: [status(1, "success", { target_url: RUN })] }] });
    expect(noCommit.commit).toBeNull();
    expect(noCommit.deployments[0]!.association).toBe("conflicting");
    expect(noCommit.notes[0]).toBe("The run's commit is unknown, so nothing can be tied to it by commit.");
    expect(evidence(null).notes).toEqual(["Deployments were not loaded, so it is not known whether this commit was deployed."]);
  });

  it("a successful run with no deployment evidence says so instead of implying a deployment", () => {
    const e = evidence([]);
    expect(e.deployments).toEqual([]);
    expect(e.notes).toEqual(["The run succeeded, but GitHub lists no deployment of its commit: a successful run is not a deployment."]);
    expect(releaseEvidence({ repo, run: run({ conclusion: "failure" }), deployments: [] }).notes).toEqual(["GitHub lists no deployment of this run's commit."]);
  });

  it("ambiguous or conflicting links: another run, both runs, another repository or host, another status environment", () => {
    const other = "https://github.com/acme-synthetic/app/actions/runs/777";
    const e = evidence([
      { deployment: dep(1), statuses: [status(1, "success", { target_url: other })] },
      { deployment: dep(2), statuses: [status(2, "success", { target_url: RUN }), status(3, "success", { log_url: other })] },
      { deployment: dep(3), statuses: [status(4, "success", { target_url: "https://github.com/someone-else/app/actions/runs/500" })] },
      { deployment: dep(4), statuses: [status(5, "success", { target_url: "https://example.test/acme-synthetic/app/actions/runs/500" })] },
      { deployment: dep(5), statuses: [status(6, "success", { environment: "env-z", target_url: RUN })] },
    ]);
    expect(e.deployments.map((d) => [d.id, d.association, d.linkedRunId])).toEqual([
      [1, "same commit", 777],
      [2, "conflicting", 777],
      [3, "same commit", undefined],
      [4, "same commit", undefined],
      [5, "confirmed", undefined],
    ]);
    expect(e.deployments[0]!.basis[0]).toBe("Same commit, but its statuses link to another run.");
    expect(e.deployments[4]!.basis[1]).toBe("Its statuses name another environment too: env-z.");
  });

  it("artifacts: confirmed by their workflow run; never linked to a deployment or release", () => {
    const e = evidence([], {
      artifacts: [
        { id: 1, name: "dist", size_in_bytes: 1024, workflow_run: { id: 500, head_sha: C } },
        { id: 2, name: "report", expired: true, workflow_run: { id: 501, head_sha: C } },
        { id: 3, name: "bundle", workflow_run: null },
      ],
    });
    expect(e.artifacts.map((a) => [a.name, a.association, a.expired])).toEqual([
      ["dist", "confirmed", false],
      ["report", "conflicting", true],
      ["bundle", "unknown", false],
    ]);
    expect(e.notes).toContain("GitHub does not link artifacts to deployments or releases; artifacts are listed for the run only.");
  });

  it("reads run links only from the run's host and path shape", () => {
    expect(linkedRun(`${RUN}/job/9`, "github.com")).toEqual({ repo, runId: 500, jobId: 9 });
    expect(linkedRun(`${RUN}/attempts/2`, "github.com")).toEqual({ repo, runId: 500 });
    expect(linkedRun("https://github.com/acme-synthetic/app/actions/runs/500abc", "github.com")).toBeNull();
    expect(linkedRun("not a url", "github.com")).toBeNull();
    expect(linkedRun(null, "github.com")).toBeNull();
    expect(linkedRun(RUN, "ghe.example.test")).toBeNull();
  });
});

describe("job-environment records joined to GitHub deployments", () => {
  const record = (environment: string, jobIds: number[], extra: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
    runId: 500,
    runAttempt: 1,
    commit: C,
    environment,
    provenance: "declared",
    outcome: "succeeded",
    jobs: jobIds.length,
    jobIds,
    ...extra,
  });
  const join = (records: DeploymentRecord[], deployments: EvidenceInput["deployments"]) => environmentJoin(records, evidence(deployments));
  const rows = (j: ReturnType<typeof environmentJoin>) => j.records.map((r) => [r.environment, r.deployments.map((d) => [d.id, d.match, d.jobId ?? null]), r.note ?? null]);

  it("same environment and commit: tied to the job only when its status names one of the record's jobs, otherwise a candidate", () => {
    const j = join(
      [record("env-a", [9, 10])],
      [
        { deployment: dep(1, { environment: "ENV-A" }), statuses: [status(1, "success", { log_url: `${RUN}/job/9`, target_url: `${RUN}/job/9` })] },
        { deployment: dep(2), statuses: [status(2, "success", { target_url: "https://deploy.example.test/42" })] },
      ],
    );
    expect(rows(j)).toEqual([["env-a", [[1, "job linked", 9], [2, "candidate", null]], null]]);
    expect(j.records[0]!.deployments[1]!.basis).toContain("another run or tool may have created it");
    expect(j.unmatched).toEqual([]);
  });

  it("same environment but another commit is no match; one that links to this run is a conflict", () => {
    const j = join(
      [record("env-a", [9])],
      [
        { deployment: dep(1, { sha: OTHER }), statuses: [status(1, "success")] },
        { deployment: dep(2, { sha: OTHER }), statuses: [status(2, "success", { log_url: `${RUN}/job/9` })] },
      ],
    );
    expect(rows(j)).toEqual([["env-a", [[2, "conflicting", null]], null]]);
    expect(j.records[0]!.deployments[0]!.basis).toContain("not the run's ccccccc");
  });

  it("several deployments to one environment and commit are each kept with their own match", () => {
    const j = join(
      [record("env-a", [9])],
      [
        { deployment: dep(1), statuses: [status(1, "inactive", { log_url: `${RUN}/job/9` })] },
        { deployment: dep(2), statuses: [status(2, "success", { log_url: "https://github.com/acme-synthetic/app/actions/runs/600/job/61" })] },
        { deployment: dep(3), statuses: null },
      ],
    );
    expect(rows(j)).toEqual([["env-a", [[1, "job linked", 9], [2, "another run", null], [3, "candidate", null]], null]]);
    expect(j.records[0]!.deployments[1]!.basis).toBe("Same commit and environment, but its statuses link to run 600.");
    expect(j.records[0]!.deployments[2]!.basis).toContain("could not be read");
  });

  it("confirmed for the run but not attributable to one job: no job named, a job outside the record, or two of its jobs", () => {
    const j = join(
      [record("env-a", [9, 10])],
      [
        { deployment: dep(1), statuses: [status(1, "success", { target_url: RUN })] },
        { deployment: dep(2), statuses: [status(2, "success", { log_url: `${RUN}/job/77` })] },
        { deployment: dep(3), statuses: [status(3, "queued", { log_url: `${RUN}/job/9` }), status(4, "success", { log_url: `${RUN}/job/10` })] },
      ],
    );
    expect(rows(j)).toEqual([["env-a", [[1, "run confirmed", null], [2, "run confirmed", null], [3, "run confirmed", null]], null]]);
    expect(j.records[0]!.deployments.map((d) => d.basis)).toEqual([
      "Its statuses link to this run but name no job, so which job created it is not known.",
      "Its statuses link to job 77 of this run, which is not one of this attempt's jobs that use env-a.",
      "Its statuses link to 2 of this run's jobs that use env-a, so which one created it is not known.",
    ]);
  });

  it("missing environment or commit: never matched by guess", () => {
    const j = join(
      [record("env-a", [9])],
      [
        { deployment: dep(1, { environment: null }), statuses: [status(1, "success", { log_url: `${RUN}/job/9` })] },
        { deployment: dep(2, { sha: null }), statuses: [status(2, "success")] },
      ],
    );
    expect(rows(j)).toEqual([["env-a", [[2, "unknown", null]], null]]);
    expect(j.unmatched).toEqual([{ id: 1, environment: null, basis: "GitHub reported no environment for this deployment." }]);
    // A record whose commit is not a full SHA cannot be compared either.
    const k = join([record("env-a", [9], { commit: "abc" })], [{ deployment: dep(3), statuses: [status(3, "success")] }]);
    expect(rows(k)).toEqual([["env-a", [[3, "unknown", null]], null]]);
  });

  it("statuses linking to this run and to another run: conflicting, not attributed to the job", () => {
    const j = join([record("env-a", [9])], [{ deployment: dep(1), statuses: [status(1, "queued", { log_url: `${RUN}/job/9` }), status(2, "success", { log_url: "https://github.com/acme-synthetic/app/actions/runs/777/job/1" })] }]);
    expect(rows(j)).toEqual([["env-a", [[1, "conflicting", null]], null]]);
  });

  it("a job declares an environment but GitHub lists no deployment to it; deployments to environments no record names are listed apart", () => {
    const j = join([record("env-a", [9]), record("env-b", [11], { outcome: "skipped" })], [{ deployment: dep(1, { environment: "env-c" }), statuses: [] }]);
    expect(rows(j)).toEqual([
      ["env-a", [], "This run's jobs use env-a, but GitHub lists no deployment of this commit to it."],
      ["env-b", [], "This run's jobs use env-b, but GitHub lists no deployment of this commit to it."],
    ]);
    expect(j.records[1]!.outcome).toBe("skipped");
    expect(j.unmatched).toEqual([{ id: 1, environment: "env-c", basis: "No job-environment record of this run (declared or from an input) names env-c." }]);
    expect(environmentJoin([record("env-a", [9])], null).records[0]!.note).toBe("GitHub deployments were not loaded.");
  });
});
