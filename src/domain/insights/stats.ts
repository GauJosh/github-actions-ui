// Run statistics from one run's jobs and its dependency graph. Pure: no I/O.
//
// Durations, defined once:
// - a job's duration: `completed_at - started_at`. Queue time (`created_at` to `started_at`) is not part of it.
//   A job without both timestamps has no duration; it is never counted as zero.
// - wall clock: first job start to last job completion, only when every job has completed (otherwise "so far",
//   up to the latest timestamp GitHub reported, and labelled partial).
// - summed job time: the sum of job durations (machine time); it can exceed the wall clock when jobs run in parallel.
// - critical path: the longest chain of job durations through `needs`, using the dependency graph. It excludes time
//   spent waiting between jobs (queues, approvals). Unavailable when the graph has no dependencies from a workflow
//   file, or when a job on a candidate chain ran without timestamps.
// Nothing here is historical: one run's results are not a success rate.
import { durationMs, jobStatus, type NodeStatus, type RunGraph } from "../graph/build";
import type { Job } from "../types";

export type CountBucket = "succeeded" | "failed" | "cancelled" | "timed out" | "skipped" | "running" | "waiting" | "queued" | "other";
export const COUNT_ORDER: CountBucket[] = ["succeeded", "failed", "timed out", "cancelled", "skipped", "running", "waiting", "queued", "other"];

const BUCKET: Record<NodeStatus, CountBucket> = {
  success: "succeeded",
  neutral: "succeeded",
  failure: "failed",
  timed_out: "timed out",
  cancelled: "cancelled",
  skipped: "skipped",
  in_progress: "running",
  waiting: "waiting",
  queued: "queued",
  unknown: "other",
  not_run: "other",
};
export const bucketOf = (job: Pick<Job, "status" | "conclusion">): CountBucket => BUCKET[jobStatus(job)];

export type TimedJob = { job: Job; ms: number };
export type CriticalPath = { ms: number; nodeKeys: string[]; jobs: number } | { unavailable: string };

export type RunStats = {
  total: number;
  counts: Partial<Record<CountBucket, number>>;
  /** First job start → last job completion; `partial` while jobs are still running or waiting. */
  wallClock?: { ms: number; partial: boolean };
  /** Sum of the durations of jobs with both timestamps. */
  summedMs: number;
  /** Jobs with a duration (started and completed, not skipped). */
  timed: number;
  /** Jobs that completed (not skipped) but have no usable timestamps. */
  missingTiming: number;
  slowest: TimedJob[];
  fastest: TimedJob[];
  criticalPath: CriticalPath;
};

const RANKED = 3;

export function jobDurationMs(job: Job): number | undefined {
  if (jobStatus(job) === "skipped") return undefined;
  return durationMs(job.started_at, job.completed_at);
}

export function computeRunStats(jobs: Job[], graph?: RunGraph | null): RunStats {
  const counts: Partial<Record<CountBucket, number>> = {};
  for (const j of jobs) counts[bucketOf(j)] = (counts[bucketOf(j)] ?? 0) + 1;

  const timed: TimedJob[] = [];
  let missingTiming = 0;
  for (const job of jobs) {
    const ms = jobDurationMs(job);
    if (ms !== undefined) timed.push({ job, ms });
    else if (job.status === "completed" && jobStatus(job) !== "skipped") missingTiming++;
  }
  const byMs = [...timed].sort((a, b) => b.ms - a.ms || a.job.id - b.job.id);

  const starts = jobs.map((j) => j.started_at).filter((t): t is string => !!t).sort();
  const ends = jobs.map((j) => j.completed_at).filter((t): t is string => !!t).sort();
  const latest = [...starts, ...ends].sort().at(-1);
  const done = jobs.length > 0 && jobs.every((j) => j.status === "completed");
  const wallMs = starts.length ? durationMs(starts[0], done ? ends.at(-1) : latest) : undefined;

  return {
    total: jobs.length,
    counts,
    ...(wallMs !== undefined && { wallClock: { ms: wallMs, partial: !done } }),
    summedMs: timed.reduce((s, t) => s + t.ms, 0),
    timed: timed.length,
    missingTiming,
    slowest: byMs.slice(0, RANKED),
    fastest: [...byMs].reverse().slice(0, RANKED),
    criticalPath: graph ? criticalPath(graph) : { unavailable: "The dependency graph is still loading." },
  };
}

/** The longest chain of job durations through the graph's edges (see the header for what it excludes). */
export function criticalPath(graph: RunGraph): CriticalPath {
  if (graph.evidence.kind !== "workflow-file") return { unavailable: "Dependencies are unknown without the workflow file." };
  if (graph.edges.length === 0) return { unavailable: "The workflow declares no dependencies between jobs, so every job is its own path." };
  // A node's duration: from its first member's start to its last member's end (matrix legs and called jobs run in
  // parallel). Nodes that did not run take no time on a path. A node that ran without timestamps is unknown.
  const cost = new Map<string, number | null>();
  for (const n of graph.nodes) {
    const ran = n.members.filter((m) => !["skipped", "not_run"].includes(jobStatus(m.job)));
    if (ran.length === 0) {
      cost.set(n.key, 0);
      continue;
    }
    if (ran.some((m) => m.job.status !== "completed")) return { unavailable: "Jobs are still running, so the critical path is not final." };
    const start = ran.map((m) => m.job.started_at).filter((t): t is string => !!t).sort()[0];
    const end = ran.map((m) => m.job.completed_at).filter((t): t is string => !!t).sort().at(-1);
    const ms = ran.every((m) => m.job.started_at && m.job.completed_at) ? durationMs(start, end) : undefined;
    cost.set(n.key, ms ?? null);
  }
  const preds = new Map(graph.nodes.map((n) => [n.key, [] as string[]]));
  for (const e of graph.edges) preds.get(e.to)?.push(e.from);
  const best = new Map<string, { ms: number; path: string[] } | null>();
  const visiting = new Set<string>();
  let cyclic = false;
  const visit = (k: string): { ms: number; path: string[] } | null => {
    if (best.has(k)) return best.get(k)!;
    if (visiting.has(k)) {
      cyclic = true;
      return null;
    }
    visiting.add(k);
    const own = cost.get(k) ?? null;
    let result: { ms: number; path: string[] } | null = null;
    if (own !== null) {
      let longest: { ms: number; path: string[] } | null = { ms: 0, path: [] };
      for (const p of preds.get(k) ?? []) {
        const r = visit(p);
        if (r === null) {
          longest = null;
          break;
        }
        if (r.ms > longest.ms) longest = r;
      }
      result = longest ? { ms: longest.ms + own, path: [...longest.path, k] } : null;
    }
    visiting.delete(k);
    best.set(k, result);
    return result;
  };
  let top: { ms: number; path: string[] } | null = null;
  for (const n of graph.nodes) {
    const r = visit(n.key);
    if (r === null) return { unavailable: cyclic ? "The dependencies form a cycle." : `“${n.label}” or a job it needs ran without timestamps, so the longest chain cannot be measured.` };
    if (!top || r.ms > top.ms) top = r;
  }
  const path = top!.path.filter((k) => (cost.get(k) ?? 0) > 0);
  const jobsOnPath = path.reduce((s, k) => s + (graph.nodes.find((n) => n.key === k)?.members.length ?? 0), 0);
  return { ms: top!.ms, nodeKeys: path, jobs: jobsOnPath };
}
