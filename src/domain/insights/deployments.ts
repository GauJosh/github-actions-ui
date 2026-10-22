// Deployments in one run: the building block for future DORA-style metrics. Pure: no I/O.
//
// What one run can say reliably: which environments it deployed to (jobs with an `environment:`, from the
// workflow files), when those jobs ran, and whether they succeeded. It cannot say on its own:
//   - deployment frequency: needs a defined population of runs (which workflows, branches, environments) over time;
//   - lead time for changes: needs each deployed commit's first-commit or merge time, across runs;
//   - change failure rate: needs a definition of a failed change (a failed deployment? a rollback? an incident?)
//     across deployments;
//   - time to restore: needs failures and the later deployment that recovered, across runs.
// These are deliberately NOT computed here. A future historical view will aggregate DeploymentRecord values from a
// stated set of runs, after "production environment", "change", "failure" and "recovery" are defined explicitly.
import { jobStatus, type RunGraph } from "../graph/build";
import type { EnvProvenance, ReleaseOverview } from "../phases/phases";
import type { Run } from "../types";

export type DeploymentOutcome = "succeeded" | "failed" | "rolled back" | "rejected" | "running" | "skipped" | "not started";

export type DeploymentRecord = {
  runId: number;
  runAttempt: number;
  commit: string;
  environment: string;
  /** How the environment was established for the deploying jobs (always declared or from an input). */
  provenance: EnvProvenance;
  startedAt?: string;
  completedAt?: string;
  outcome: DeploymentOutcome;
  /** Jobs that declare (or receive) this environment. */
  jobs: number;
};

/** Deployments of one run, from jobs whose environment is declared or passed by a caller (never inferred). */
export function deploymentsOf(run: Pick<Run, "id" | "run_attempt" | "head_sha">, graph: RunGraph, overview?: ReleaseOverview | null): DeploymentRecord[] {
  const byEnv = new Map<string, typeof graph.nodes>();
  for (const n of graph.nodes) {
    if (!n.environment || n.source !== "workflow-file") continue;
    (byEnv.get(n.environment) ?? byEnv.set(n.environment, []).get(n.environment)!).push(n);
  }
  const out: DeploymentRecord[] = [];
  for (const [environment, nodes] of byEnv) {
    const jobs = nodes.flatMap((n) => n.members.map((m) => m.job));
    const statuses = jobs.map(jobStatus);
    const phase = overview?.phases.find((p) => p.environment === environment);
    const gate = overview?.gates.get(environment);
    let outcome: DeploymentOutcome;
    if (gate?.state === "rejected") outcome = "rejected";
    else if (statuses.some((s) => s === "failure" || s === "timed_out")) outcome = phase?.status === "recovered" ? "rolled back" : "failed";
    else if (statuses.some((s) => ["in_progress", "queued", "waiting"].includes(s))) outcome = "running";
    else if (jobs.length && statuses.every((s) => s === "skipped")) outcome = "skipped";
    else if (jobs.length === 0) outcome = "not started";
    else outcome = "succeeded";
    // Skipped jobs did not deploy; GitHub's timestamps for them are not deployment time.
    const ran = jobs.filter((j) => jobStatus(j) !== "skipped");
    const starts = ran.map((j) => j.started_at).filter((t): t is string => !!t).sort();
    const ends = ran.map((j) => j.completed_at).filter((t): t is string => !!t).sort();
    const done = ran.length > 0 && ran.every((j) => j.status === "completed");
    out.push({
      runId: run.id,
      runAttempt: run.run_attempt,
      commit: run.head_sha,
      environment,
      provenance: nodes.every((n) => n.environmentEvidence !== "input") ? "declared" : "input",
      ...(starts[0] && { startedAt: starts[0] }),
      ...(done && ends.at(-1) && { completedAt: ends.at(-1) }),
      outcome,
      jobs: jobs.length,
    });
  }
  // Deployments that started, in order; the rest after them.
  return out.sort((a, b) => (a.startedAt === b.startedAt ? 0 : a.startedAt === undefined ? 1 : b.startedAt === undefined ? -1 : a.startedAt < b.startedAt ? -1 : 1));
}
