// Retry evidence within one run: what each job did in the attempts of that run, and whether a job that failed
// succeeded when it ran again; and, separately, each job's outcome across distinct runs of the workflow. Pure: no I/O,
// no clock, the same result for the same input in any order.
//
// Rules:
// - each attempt is one side as GitHub listed it (`…/attempts/{n}/jobs`), with its own graph for job identity;
// - a job is observed once, by job id, in the attempt it ran in. GitHub may list a job in a later attempt that it
//   reports as run in an earlier one (not re-run); that is not a new observation. A job listed in a later attempt
//   without `run_attempt` cannot be placed, and is not used for findings;
// - jobs are matched between attempts by workflow identity (identity.ts), or by exact display name when the workflow
//   file is unavailable. An identity held by two or more jobs in one attempt is ambiguous and gets no finding;
// - outcomes: the conclusions failure, startup_failure and timed_out are failed, success is succeeded;
//   anything else (cancelled, skipped, neutral, queued, in progress…) is neither;
// - an attempt that was not read is reported as missing, never counted as a success;
// - findings are about jobs, not tests, and never name a cause.
//
// Across runs (history.ts conventions):
// - each run counts once, at its latest attempt: the run under investigation only when its latest attempt was read
//   and completed, each earlier run at the attempt it was loaded with (which must be its latest). Earlier attempts
//   never add runs. A job listed in the latest attempt but run in an earlier one is the run's outcome for that job;
// - only completed runs of the same workflow are compared; the others are listed with the reason;
// - one matching basis for the whole comparison: workflow identity when every run compared has its workflow file,
//   otherwise exact display names for every run ("matched by name only"), so the two are never mixed. An identity
//   held by two or more jobs in one run is ambiguous: no recurrence or mixed-outcome finding for it;
// - runs that could not be read, and history that was not loaded, are reported and never counted as outcomes.
//   Findings describe the runs loaded, not every run of the workflow.
import type { RunGraph } from "../graph/build";
import { jobStatus } from "../graph/build";
import { identities } from "../compare/identity";
import type { Job, Run } from "../types";
import { sameWorkflow, type HistoryRun } from "./history";

/** One attempt of the run: the run as GitHub returned it for that attempt, that attempt's jobs and its graph. */
export type AttemptJobs = { attempt: number; run: Run; jobs: Job[]; graph: RunGraph | null };

export type RetryInput = {
  runId: number;
  /** The run's latest attempt number, as GitHub reports it. */
  latestAttempt: number;
  attempts: AttemptJobs[];
  /** Attempts that were requested but could not be read. */
  unread: { attempt: number; why: string }[];
  /** Earlier runs of the workflow as loaded; null or absent: history was not loaded. */
  history?: HistoryInput | null;
};

/** Earlier runs of the workflow (loadHistory's result), each at the attempt it was loaded with. */
export type HistoryInput = {
  runs: HistoryRun[];
  /** Runs whose jobs could not be read. */
  failed: { runId: number; attempt: number; why: string }[];
  /** How many runs GitHub listed. */
  listed: number;
  /** The most runs that are loaded. */
  limit: number;
};

export type RetryOutcome = "failed" | "succeeded" | "other";

/** A fact: one job as GitHub reports it. */
export type JobObservation = {
  runId: number;
  jobId: number;
  name: string;
  /** The first attempt whose listing included this job. */
  listedInAttempt: number;
  /** The attempt the job ran in; null when GitHub's data does not establish it. */
  ranInAttempt: number | null;
  status: string;
  conclusion: string | null;
  outcome: RetryOutcome;
  completedAt?: string;
};

export const RECOVERY_CAVEAT =
  "A success on a later attempt does not by itself show that the job is flaky, or why it failed: the retry may have run under different conditions (runner, timing, external services) that GitHub's API does not report.";

/** An interpretation of the observations. */
export type RetryFinding =
  | { kind: "recovered on retry"; failed: JobObservation; succeeded: JobObservation; caveat: string }
  | { kind: "failed in every attempt observed"; attempts: number[] }
  | { kind: "insufficient evidence"; reasons: string[] };

export type JobRetryEvidence = {
  identity: { key: string; basis: "workflow-file" | "name"; label: string };
  observations: JobObservation[];
  findings: RetryFinding[];
  notes: string[];
};

export type RetryEvidence = {
  runId: number;
  /** Attempts whose jobs were read, ascending. */
  attemptsRead: number[];
  /** Attempts of the run that were not read, with the reason, ascending. */
  attemptsMissing: { attempt: number; why: string }[];
  jobs: JobRetryEvidence[];
  notes: string[];
  acrossRuns: CrossRunEvidence;
};

/** A fact: one job of one run, at the run's latest attempt. */
export type RunJobObservation = {
  runId: number;
  attempt: number;
  runNumber?: number;
  /** The run under investigation. */
  target: boolean;
  commit: string;
  branch: string | null;
  event: string;
  jobId: number;
  name: string;
  status: string;
  conclusion: string | null;
  outcome: RetryOutcome;
  completedAt?: string;
};

export type CrossRunFinding =
  | { kind: "recurring failure"; failedRunIds: number[]; runsObserved: number; runsCompared: number }
  | { kind: "mixed outcomes"; failedRunIds: number[]; succeededRunIds: number[]; sameCommit: boolean; commitsWithBoth: string[] }
  | { kind: "insufficient evidence"; reasons: string[] };

export type CrossRunJob = {
  identity: JobRetryEvidence["identity"];
  /** One per run the job was observed in (runs where its identity is ambiguous are left out). */
  observations: RunJobObservation[];
  counts: { failed: number; succeeded: number; other: number };
  /** Runs in which more than one job has this identity, ascending. */
  ambiguousIn: number[];
  findings: CrossRunFinding[];
  notes: string[];
};

export type CrossRunEvidence = {
  history: "not loaded" | "loaded";
  /** The run under investigation at its latest attempt; counted only when that attempt was read and completed. */
  target: { runId: number; attempt: number; included: boolean; why?: string };
  basis: "workflow-file" | "name";
  /** From the history: how many runs GitHub listed and the most that are loaded. */
  listed?: number;
  limit?: number;
  /** Runs compared (this run when included, and earlier runs), ascending. */
  runsCompared: number[];
  /** Earlier runs that could not be read, ascending. Not counted. */
  unread: { runId: number; attempt: number; why: string }[];
  /** Loaded runs that are not compared, with the reason, ascending. */
  excluded: { runId: number; attempt: number; why: string }[];
  jobs: CrossRunJob[];
  notes: string[];
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "attempt 2", "attempts 1 and 3", "attempts 1, 2 and 3". */
const numbered = (word: string, values: (string | number)[]) =>
  `${word}${values.length === 1 ? "" : "s"} ${values.length > 1 ? `${values.slice(0, -1).join(", ")} and ${values.at(-1)}` : values.join("")}`;

// startup_failure is included by decision: the job was attempted and did not succeed, so a later success is a recovery.
const FAILED_CONCLUSIONS = new Set(["failure", "startup_failure", "timed_out"]);

function outcomeOf(job: Job): RetryOutcome {
  if (job.status === "completed" && job.conclusion !== null && FAILED_CONCLUSIONS.has(job.conclusion)) return "failed";
  if (jobStatus(job) === "success") return "succeeded";
  return "other";
}

/** The attempt a job listed in `listed` ran in, from GitHub's `run_attempt`; null when that is not established. */
function ranIn(job: Job, listed: number): number | null {
  if (job.run_attempt === undefined) return listed === 1 ? 1 : null;
  return Number.isInteger(job.run_attempt) && job.run_attempt >= 1 && job.run_attempt <= listed ? job.run_attempt : null;
}

export function retryEvidence(input: RetryInput): RetryEvidence {
  const notes: string[] = [];
  const missing = new Map<number, string>();
  for (const u of [...input.unread].sort((a, b) => a.attempt - b.attempt || cmp(a.why, b.why))) if (!missing.has(u.attempt)) missing.set(u.attempt, u.why);

  // Attempts that can be used: of this run, within its attempts, and supplied once.
  const supplied = new Map<number, AttemptJobs[]>();
  for (const a of input.attempts) (supplied.get(a.attempt) ?? supplied.set(a.attempt, []).get(a.attempt)!).push(a);
  const attempts: AttemptJobs[] = [];
  for (const [n, list] of [...supplied].sort((a, b) => a[0] - b[0])) {
    const a = list[0]!;
    if (!Number.isInteger(n) || n < 1 || n > input.latestAttempt) notes.push(`Attempt ${n} is not an attempt of this run (it has ${plural(input.latestAttempt, "attempt")}), so it is not used.`);
    else if (list.length > 1) missing.set(n, "it was supplied more than once");
    else if (a.run.id !== input.runId || a.run.run_attempt !== n) missing.set(n, `GitHub's data for it is of another run or attempt`);
    else if (!missing.has(n)) attempts.push(a);
  }
  for (let n = 1; n <= input.latestAttempt; n++) if (!attempts.some((a) => a.attempt === n) && !missing.has(n)) missing.set(n, "it was not loaded");
  const attemptsMissing = [...missing].filter(([n]) => n >= 1 && n <= input.latestAttempt).sort((a, b) => a[0] - b[0]).map(([attempt, why]) => ({ attempt, why }));
  if (attemptsMissing.length) {
    notes.push(`Not read: ${attemptsMissing.map((m) => `attempt ${m.attempt} (${m.why})`).join(", ")}. What happened in ${attemptsMissing.length === 1 ? "it" : "them"} is unknown, not a success.`);
  }

  // Observations, each job once (by id), placed by identity. Ambiguity is counted per attempt listing.
  type Group = { identity: JobRetryEvidence["identity"]; observations: JobObservation[]; ambiguousIn: Set<number> };
  const groups = new Map<string, Group>();
  const seen = new Set<number>();
  let unplaced = 0;
  const bases = new Map<string, Set<string>>();
  for (const a of attempts) {
    const jobs = [...a.jobs].sort((x, y) => x.id - y.id);
    const ids = identities({ jobs, graph: a.graph });
    const perKey = new Map<string, Set<number>>();
    for (const j of jobs) {
      const key = ids.get(j.id)!.key;
      (perKey.get(key) ?? perKey.set(key, new Set()).get(key)!).add(j.id);
    }
    for (const j of jobs) {
      const id = ids.get(j.id)!;
      const g = groups.get(id.key) ?? { identity: { key: id.key, basis: id.basis, label: id.label }, observations: [], ambiguousIn: new Set<number>() };
      groups.set(id.key, g);
      (bases.get(j.name) ?? bases.set(j.name, new Set()).get(j.name)!).add(id.basis);
      if (perKey.get(id.key)!.size > 1) g.ambiguousIn.add(a.attempt);
      if (seen.has(j.id)) continue;
      seen.add(j.id);
      const ran = ranIn(j, a.attempt);
      if (ran === null) unplaced++;
      g.observations.push({
        runId: input.runId,
        jobId: j.id,
        name: j.name,
        listedInAttempt: a.attempt,
        ranInAttempt: ran,
        status: j.status,
        conclusion: j.conclusion,
        outcome: outcomeOf(j),
        ...(j.completed_at && { completedAt: j.completed_at }),
      });
    }
  }
  if (unplaced) notes.push(`GitHub's data does not say which attempt ${plural(unplaced, "job")} ran in, so ${unplaced === 1 ? "it is" : "they are"} not used for findings.`);
  for (const [name, b] of [...bases].sort((x, y) => cmp(x[0], y[0]))) {
    if (b.size > 1) notes.push(`“${name}” is identified by the workflow file in some attempts and by name only in others, so those jobs are not matched between attempts.`);
  }

  const jobs = [...groups.values()]
    .sort((x, y) => cmp(x.identity.key, y.identity.key))
    .map((g): JobRetryEvidence => {
      const observations = g.observations.sort((x, y) => (x.ranInAttempt ?? x.listedInAttempt) - (y.ranInAttempt ?? y.listedInAttempt) || x.listedInAttempt - y.listedInAttempt || x.jobId - y.jobId);
      return { identity: g.identity, observations, ...judge(g.identity, observations, [...g.ambiguousIn].sort((a, b) => a - b)) };
    });
  return { runId: input.runId, attemptsRead: attempts.map((a) => a.attempt), attemptsMissing, jobs, notes, acrossRuns: acrossRuns(input, attempts) };
}

function judge(identity: JobRetryEvidence["identity"], observations: JobObservation[], ambiguousIn: number[]): Pick<JobRetryEvidence, "findings" | "notes"> {
  const notes: string[] = [];
  if (identity.basis === "name") notes.push("Matched between attempts by its exact name only: the workflow file was not available.");
  const anyFailed = observations.some((o) => o.outcome === "failed");
  if (ambiguousIn.length) {
    const why = `In ${numbered("attempt", ambiguousIn)}, more than one job has this identity, so its jobs cannot be told apart between attempts.`;
    return { findings: anyFailed ? [{ kind: "insufficient evidence", reasons: [why] }] : [], notes: [...notes, why] };
  }
  const placed = observations.filter((o): o is JobObservation & { ranInAttempt: number } => o.ranInAttempt !== null);
  const unplaced = observations.length - placed.length;
  if (unplaced) notes.push(`GitHub's data does not say which attempt ${plural(unplaced, "of its jobs")} ran in.`);
  // One observation per attempt; two jobs placed in the same attempt would mean the identity is not reliable.
  const byAttempt = new Map<number, number>();
  for (const o of placed) byAttempt.set(o.ranInAttempt, (byAttempt.get(o.ranInAttempt) ?? 0) + 1);
  const clash = [...byAttempt].filter(([, n]) => n > 1).map(([a]) => a);
  if (clash.length) {
    const why = `More than one job with this identity ran in ${numbered("attempt", clash)}, so they cannot be told apart.`;
    return { findings: anyFailed ? [{ kind: "insufficient evidence", reasons: [why] }] : [], notes: [...notes, why] };
  }

  const findings: RetryFinding[] = [];
  const firstSuccessAfterFailure = placed.find((o) => o.outcome === "succeeded" && placed.some((f) => f.outcome === "failed" && f.ranInAttempt < o.ranInAttempt));
  if (firstSuccessAfterFailure) {
    const failed = placed.filter((f) => f.outcome === "failed" && f.ranInAttempt < firstSuccessAfterFailure.ranInAttempt).at(-1)!;
    findings.push({ kind: "recovered on retry", failed, succeeded: firstSuccessAfterFailure, caveat: RECOVERY_CAVEAT });
    const again = placed.filter((o) => o.outcome === "failed" && o.ranInAttempt > firstSuccessAfterFailure.ranInAttempt);
    if (again.length) notes.push(`It failed again in ${numbered("attempt", again.map((o) => o.ranInAttempt))}.`);
    return { findings, notes };
  }
  if (!anyFailed) return { findings, notes };

  const reasons: string[] = [];
  const attempts = placed.map((o) => o.ranInAttempt);
  if (placed.length >= 2 && placed.every((o) => o.outcome === "failed")) {
    findings.push({ kind: "failed in every attempt observed", attempts });
    return { findings, notes };
  }
  // A single run of the job is not a retry: nothing to find, only said.
  if (placed.length === 1 && !unplaced) return { findings, notes: [...notes, `It ran in attempt ${placed[0]!.ranInAttempt} only, so there is no retry to compare.`] };
  if (unplaced) reasons.push("Some of its jobs cannot be placed in an attempt, so a retry cannot be established.");
  for (const o of placed) if (o.outcome === "other") reasons.push(`In attempt ${o.ranInAttempt} it ended ${o.conclusion ?? o.status}, which is neither a failure nor a success.`);
  const lastFailed = placed.filter((o) => o.outcome === "failed").at(-1);
  if (lastFailed && placed.some((o) => o.outcome === "succeeded" && o.ranInAttempt < lastFailed.ranInAttempt) && !placed.some((o) => o.ranInAttempt > lastFailed.ranInAttempt)) {
    reasons.push(`It succeeded before it failed in attempt ${lastFailed.ranInAttempt}; no later attempt shows it succeeding.`);
  }
  if (reasons.length) findings.push({ kind: "insufficient evidence", reasons });
  return { findings, notes };
}

type Compared = HistoryRun & { target: boolean };
const list = (values: (string | number)[]) => values.join(", ");

function acrossRuns(input: RetryInput, attempts: AttemptJobs[]): CrossRunEvidence {
  const notes: string[] = [];
  const history = input.history ?? null;
  const latest = attempts.find((a) => a.attempt === input.latestAttempt);
  const target: CrossRunEvidence["target"] = { runId: input.runId, attempt: input.latestAttempt, included: false };
  if (!latest) target.why = `its latest attempt (${input.latestAttempt}) was not read`;
  else if (latest.run.status !== "completed") target.why = `its latest attempt (${input.latestAttempt}) has not completed`;
  else target.included = true;
  if (target.why) notes.push(`This run is not counted across runs: ${target.why}.`);
  const reference = (latest ?? attempts.at(-1))?.run;

  const excluded: CrossRunEvidence["excluded"] = [];
  const kept: HistoryRun[] = [];
  const byId = new Map<number, HistoryRun[]>();
  for (const r of history?.runs ?? []) (byId.get(r.run.id) ?? byId.set(r.run.id, []).get(r.run.id)!).push(r);
  for (const [runId, copies] of [...byId].sort((a, b) => a[0] - b[0])) {
    const r = copies[0]!;
    const why =
      runId === input.runId
        ? "the run under investigation (its own attempts are used)"
        : copies.length > 1
          ? "the run was supplied more than once"
          : !reference
            ? "the run under investigation could not be read, so its workflow is unknown"
            : !sameWorkflow(reference, r.run)
              ? "a different workflow"
              : r.attempt !== r.run.run_attempt
                ? `not the run's latest attempt (attempt ${r.attempt} of ${r.run.run_attempt})`
                : r.run.status !== "completed"
                  ? "the run has not completed"
                  : null;
    if (why) excluded.push({ runId, attempt: r.attempt, why });
    else kept.push(r);
  }
  const unread = [...(history?.failed ?? [])].sort((a, b) => a.runId - b.runId || a.attempt - b.attempt || cmp(a.why, b.why));

  const sides: Compared[] = [...(target.included ? [{ run: latest!.run, attempt: latest!.attempt, jobs: latest!.jobs, graph: latest!.graph, target: true }] : []), ...kept.map((r) => ({ ...r, target: false }))];
  sides.sort((a, b) => a.run.id - b.run.id);
  const withFile = sides.filter((s) => s.graph?.evidence.kind === "workflow-file").length;
  const basis: CrossRunEvidence["basis"] = sides.length > 0 && withFile === sides.length ? "workflow-file" : "name";

  // Coverage.
  if (!history) notes.push("History was not loaded, so outcomes in other runs of this workflow are unknown.");
  else if (!history.runs.length && !unread.length) notes.push("History was loaded and holds no earlier runs of this workflow.");
  else notes.push(`Results describe the ${plural(kept.length, "earlier run")} compared (GitHub listed ${history.listed}; at most ${history.limit} are loaded), not every run of this workflow.`);
  if (unread.length) notes.push(`${plural(unread.length, "earlier run")} could not be read (${numbered("run", unread.map((u) => u.runId))}): ${unread.length === 1 ? "its outcome is" : "their outcomes are"} unknown and not counted.`);
  if (sides.length > 1 && basis === "name") {
    notes.push(`The workflow file was not available for ${withFile ? "every" : "the"} run compared, so jobs are matched across runs by exact name only.`);
  }
  const branches = [...new Set(sides.map((s) => s.run.head_branch ?? "(none)"))].sort(cmp);
  const events = [...new Set(sides.map((s) => s.run.event))].sort(cmp);
  if (branches.length > 1) notes.push(`The runs compared are on ${branches.length} branches (${list(branches)}); findings are not limited to one branch.`);
  if (events.length > 1) notes.push(`The runs compared were triggered by ${events.length} events (${list(events)}).`);

  // Observations: one per run and identity; an identity held by several jobs of one run is ambiguous there.
  type Group = { identity: JobRetryEvidence["identity"]; observations: RunJobObservation[]; ambiguousIn: number[] };
  const groups = new Map<string, Group>();
  const bases = new Map<string, Set<string>>();
  for (const s of sides) {
    const jobs = [...s.jobs].sort((x, y) => x.id - y.id);
    const ids = identities({ jobs, graph: basis === "workflow-file" ? s.graph : null });
    const perKey = new Map<string, Job[]>();
    for (const j of jobs) {
      const key = ids.get(j.id)!.key;
      (perKey.get(key) ?? perKey.set(key, []).get(key)!).push(j);
    }
    for (const [key, js] of perKey) {
      const id = ids.get(js[0]!.id)!;
      const g = groups.get(key) ?? { identity: { key, basis: id.basis, label: id.label }, observations: [], ambiguousIn: [] };
      groups.set(key, g);
      for (const j of js) (bases.get(j.name) ?? bases.set(j.name, new Set()).get(j.name)!).add(id.basis);
      if (js.length > 1) {
        g.ambiguousIn.push(s.run.id);
        continue;
      }
      const j = js[0]!;
      g.identity.label = id.label;
      g.observations.push({
        runId: s.run.id,
        attempt: s.attempt,
        ...(s.run.run_number !== undefined && { runNumber: s.run.run_number }),
        target: s.target,
        commit: s.run.head_sha,
        branch: s.run.head_branch,
        event: s.run.event,
        jobId: j.id,
        name: j.name,
        status: j.status,
        conclusion: j.conclusion,
        outcome: outcomeOf(j),
        ...(j.completed_at && { completedAt: j.completed_at }),
      });
    }
  }
  for (const [name, b] of [...bases].sort((x, y) => cmp(x[0], y[0]))) {
    if (b.size > 1) notes.push(`“${name}” is identified by the workflow file in some runs and by name only in others, so those jobs are not matched across runs.`);
  }

  const jobs = [...groups.values()].sort((x, y) => cmp(x.identity.key, y.identity.key)).map((g) => crossRunJob(g, { history, kept: kept.length, unread: unread.length, compared: sides.length }));
  return {
    history: history ? "loaded" : "not loaded",
    target,
    basis,
    ...(history && { listed: history.listed, limit: history.limit }),
    runsCompared: sides.map((s) => s.run.id).sort((a, b) => a - b),
    unread,
    excluded,
    jobs,
    notes,
  };
}

function crossRunJob(
  g: { identity: JobRetryEvidence["identity"]; observations: RunJobObservation[]; ambiguousIn: number[] },
  ctx: { history: HistoryInput | null; kept: number; unread: number; compared: number },
): CrossRunJob {
  const observations = g.observations;
  const ambiguousIn = [...g.ambiguousIn].sort((a, b) => a - b);
  const failed = observations.filter((o) => o.outcome === "failed");
  const succeeded = observations.filter((o) => o.outcome === "succeeded");
  const other = observations.filter((o) => o.outcome === "other");
  const counts = { failed: failed.length, succeeded: succeeded.length, other: other.length };
  const notes: string[] = [];
  if (g.identity.basis === "name") notes.push("Matched by name only: the workflow file was not available for every run compared.");
  const findings: CrossRunFinding[] = [];
  const ids = (os: RunJobObservation[]) => os.map((o) => o.runId).sort((a, b) => a - b);

  if (ambiguousIn.length) {
    const why = `In ${numbered("run", ambiguousIn)}, more than one job has this identity, so it cannot be matched safely across runs.`;
    notes.push(why);
    findings.push({ kind: "insufficient evidence", reasons: [why] });
    return { identity: g.identity, observations, counts, ambiguousIn, findings, notes };
  }
  if (failed.length >= 2) findings.push({ kind: "recurring failure", failedRunIds: ids(failed), runsObserved: observations.length, runsCompared: ctx.compared });
  if (failed.length && succeeded.length) {
    const failedCommits = new Set(failed.map((o) => o.commit));
    const both = [...new Set(succeeded.map((o) => o.commit).filter((c) => failedCommits.has(c)))].sort(cmp);
    findings.push({ kind: "mixed outcomes", failedRunIds: ids(failed), succeededRunIds: ids(succeeded), sameCommit: both.length > 0, commitsWithBoth: both });
  }
  if (failed.length && !findings.length) {
    const reasons: string[] = [];
    if (!ctx.history) reasons.push("History was not loaded, so other runs are unknown.");
    else if (!ctx.kept) reasons.push("No earlier run of this workflow was compared.");
    else reasons.push(`It failed in 1 of the ${plural(observations.length, "run")} it was observed in.`);
    if (ctx.unread) reasons.push(`${plural(ctx.unread, "earlier run")} could not be read; ${ctx.unread === 1 ? "its outcome is" : "their outcomes are"} unknown.`);
    for (const o of other) reasons.push(`In run ${o.runId} it ended ${o.conclusion ?? o.status}, which is neither a failure nor a success.`);
    findings.push({ kind: "insufficient evidence", reasons });
  }
  return { identity: g.identity, observations, counts, ambiguousIn, findings, notes };
}
