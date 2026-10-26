// Historical run performance: several runs of one workflow, each at one attempt with that attempt's jobs. Pure: no
// I/O, no clock, the same result for the same input.
//
// Durations, defined as for one run (stats.ts):
// - run duration: first job start → last job completion, only when the run and every job completed and every job
//   that ran has valid timestamps. The run's own timestamps are not used: GitHub reports no completion time for a
//   run, and `updated_at` also changes after the run ended (re-runs, log deletion).
// - job duration: `completed_at - started_at`. Skipped jobs have none.
// - queue time is not computed: it would need each job's `created_at`, which this model does not rely on.
// A measurement is never zero by default: missing or invalid timestamps are reported as such, and 0 ms is a real
// (valid) duration. Changes are reported as measured; nothing here says what caused them.
import { identities } from "../compare/identity";
import { jobStatus, type NodeStatus, type RunGraph } from "../graph/build";
import type { Job, Run } from "../types";

/** One run at one attempt, with that attempt's jobs and graph (a comparison side has this shape). */
export type HistoryRun = { run: Run; attempt: number; jobs: Job[]; graph: RunGraph | null };

export type Unmeasured = "in progress" | "no jobs ran" | "missing timestamps" | "invalid timestamps";
export type Measure = { ms: number } | { unavailable: Unmeasured };

export type TrendPoint = { runId: number; attempt: number; runNumber?: number; startedAt?: string; branch: string | null; status: string; conclusion: string | null; duration: Measure };
export type Excluded = { runId: number; attempt: number; why: string };
export type Trend = { points: TrendPoint[]; excluded: Excluded[] };

export type JobPerformance = {
  key: string;
  label: string;
  /** "name": matched by display name only, because a run's workflow file was not available. */
  basis: "workflow-file" | "name";
  /** Durations of runs where the job succeeded; failed or cancelled runs stopped early and measure other work. */
  samples: number;
  medianMs?: number;
  minMs?: number;
  maxMs?: number;
  stoppedEarly: number;
  untimed: number;
};
export type JobRanking = { jobs: JobPerformance[]; runs: number; excluded: Excluded[]; notes: string[] };

export type BaselineOptions = { minSamples: number };
export const BASELINE_DEFAULTS: BaselineOptions = { minSamples: 5 };
export type Baseline =
  | {
      kind: "measured";
      ms: number;
      samples: number;
      medianMs: number;
      minMs: number;
      maxMs: number;
      deltaMs: number;
      ratio?: number;
      /** Baseline runs that took less time than this run, and more. */
      faster: number;
      slower: number;
      caveats: string[];
    }
  | { kind: "insufficient"; samples: number; needed: number; why: string }
  | { kind: "not-comparable"; why: string };

const SUCCEEDED = new Set<NodeStatus>(["success", "neutral"]);
const STOPPED = new Set<NodeStatus>(["failure", "timed_out", "cancelled"]);

/** A duration from two timestamps: missing, unparsable or reversed timestamps are reported, never guessed. */
export function measure(start?: string | null, end?: string | null): Measure {
  if (!start || !end) return { unavailable: "missing timestamps" };
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return { unavailable: "invalid timestamps" };
  return { ms: b - a };
}

export function runDuration(r: HistoryRun): Measure {
  if (r.run.status !== "completed" || r.jobs.some((j) => j.status !== "completed")) return { unavailable: "in progress" };
  const ran = r.jobs.filter((j) => jobStatus(j) !== "skipped");
  if (!ran.length) return { unavailable: "no jobs ran" };
  let first = Infinity;
  let last = -Infinity;
  for (const j of ran) {
    const m = measure(j.started_at, j.completed_at);
    if ("unavailable" in m) return m;
    first = Math.min(first, Date.parse(j.started_at!));
    last = Math.max(last, Date.parse(j.completed_at!));
  }
  return { ms: last - first };
}

/** Runs of the same workflow: the same workflow id when both have one, otherwise the same file path. */
export function sameWorkflow(a: Run, b: Run): boolean {
  if (a.workflow_id !== undefined && b.workflow_id !== undefined) return a.workflow_id === b.workflow_id;
  return a.path !== undefined && a.path === b.path;
}

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const startOf = (r: HistoryRun) => r.run.run_started_at ?? r.run.created_at;
const order = (a: HistoryRun, b: HistoryRun) => (startOf(a) ?? "").localeCompare(startOf(b) ?? "") || a.run.id - b.run.id || a.attempt - b.attempt;

/** The runs of the first run's workflow, each run attempt once, in start order; the others with the reason. */
function comparable(runs: HistoryRun[], reference?: Run): { kept: HistoryRun[]; excluded: Excluded[] } {
  const ref = reference ?? runs[0]?.run;
  const kept: HistoryRun[] = [];
  const excluded: Excluded[] = [];
  const seen = new Set<string>();
  for (const r of runs) {
    const id = { runId: r.run.id, attempt: r.attempt };
    if (!ref || !sameWorkflow(ref, r.run)) excluded.push({ ...id, why: "a different workflow" });
    else if (seen.has(`${r.run.id}.${r.attempt}`)) excluded.push({ ...id, why: "the same run attempt was supplied twice" });
    else {
      seen.add(`${r.run.id}.${r.attempt}`);
      kept.push(r);
    }
  }
  return { kept: kept.sort(order), excluded };
}

/** Run durations over time, with each run's conclusion kept. Unmeasurable runs stay in the series, labelled. */
export function durationTrend(runs: HistoryRun[]): Trend {
  const { kept, excluded } = comparable(runs);
  const points = kept.map((r) => ({
    runId: r.run.id,
    attempt: r.attempt,
    ...(r.run.run_number !== undefined && { runNumber: r.run.run_number }),
    ...(startOf(r) && { startedAt: startOf(r) }),
    branch: r.run.head_branch,
    status: r.run.status,
    conclusion: r.run.conclusion,
    duration: runDuration(r),
  }));
  return { points, excluded };
}

/**
 * Jobs across runs, slowest first by median duration of the runs where they succeeded. Jobs are matched by workflow
 * identity (job id, call path, matrix values), never by display name alone when the workflow file is available.
 */
export function rankJobs(runs: HistoryRun[]): JobRanking {
  const { kept, excluded } = comparable(runs);
  const notes: string[] = [];
  const by = new Map<string, { label: string; basis: "workflow-file" | "name"; ms: number[]; stoppedEarly: number; untimed: number }>();
  for (const r of kept) {
    const ids = identities(r);
    const count = new Map<string, number>();
    for (const j of r.jobs) count.set(ids.get(j.id)!.key, (count.get(ids.get(j.id)!.key) ?? 0) + 1);
    for (const j of r.jobs) {
      const id = ids.get(j.id)!;
      // Two jobs of one run with the same name and no workflow identity cannot be told apart: not measured.
      if (count.get(id.key)! > 1) {
        const note = `In run ${r.run.id} (attempt ${r.attempt}), several jobs are named “${id.label}” and the workflow file is not available, so they are not measured.`;
        if (!notes.includes(note)) notes.push(note);
        continue;
      }
      const e = by.get(id.key) ?? { label: id.label, basis: id.basis, ms: [], stoppedEarly: 0, untimed: 0 };
      by.set(id.key, e);
      e.label = id.label;
      const status = jobStatus(j);
      if (STOPPED.has(status)) e.stoppedEarly++;
      else if (SUCCEEDED.has(status)) {
        const m = measure(j.started_at, j.completed_at);
        if ("ms" in m) e.ms.push(m.ms);
        else e.untimed++;
      }
    }
  }
  const jobs: JobPerformance[] = [...by].map(([key, e]) => ({
    key,
    label: e.label,
    basis: e.basis,
    samples: e.ms.length,
    ...(e.ms.length && { medianMs: median(e.ms)!, minMs: Math.min(...e.ms), maxMs: Math.max(...e.ms) }),
    stoppedEarly: e.stoppedEarly,
    untimed: e.untimed,
  }));
  jobs.sort((a, b) => (b.medianMs ?? -1) - (a.medianMs ?? -1) || a.key.localeCompare(b.key));
  const labels = new Map<string, Set<string>>();
  for (const j of jobs) labels.set(j.label, (labels.get(j.label) ?? new Set()).add(j.basis));
  for (const [label, bases] of labels) {
    if (bases.size > 1) notes.push(`“${label}” is listed by workflow identity and by name only: some runs had no workflow file, so they are not combined.`);
  }
  return { jobs, runs: kept.length, excluded, notes };
}

/**
 * This run's duration against the median of earlier successful runs of the same workflow. Reported as measured
 * (difference, ratio, how many baseline runs were faster or slower); no threshold decides what counts as a slowdown.
 */
export function compareToBaseline(target: HistoryRun, history: HistoryRun[], options: BaselineOptions = BASELINE_DEFAULTS): Baseline {
  const own = runDuration(target);
  if ("unavailable" in own) return { kind: "not-comparable", why: `This run has no measurable duration (${own.unavailable}).` };
  const status = jobStatus(target.run);
  if (!SUCCEEDED.has(status)) {
    return { kind: "not-comparable", why: `This run did not succeed (${target.run.conclusion ?? target.run.status}), so its duration measures different work than a successful run.` };
  }
  const start = startOf(target);
  const { kept } = comparable(history, target.run);
  const samples = kept.filter((r) => {
    if (r.run.id === target.run.id && r.attempt === target.attempt) return false;
    const s = startOf(r);
    return Boolean(start && s && s < start) && SUCCEEDED.has(jobStatus(r.run)) && "ms" in runDuration(r);
  });
  if (samples.length < options.minSamples) {
    return {
      kind: "insufficient",
      samples: samples.length,
      needed: options.minSamples,
      why: `${samples.length} earlier successful run${samples.length === 1 ? "" : "s"} of this workflow with a measurable duration; ${options.minSamples} are needed for a baseline.`,
    };
  }
  const ms = samples.map((r) => (runDuration(r) as { ms: number }).ms);
  const med = median(ms)!;
  const caveats: string[] = [];
  if (samples.some((r) => r.run.head_branch !== target.run.head_branch)) caveats.push("The baseline includes runs on other branches.");
  if (samples.some((r) => r.run.event !== target.run.event)) caveats.push("The baseline includes runs triggered by other events.");
  caveats.push("Durations are measured, not explained: a commit between the runs is not shown to be the cause of a change.");
  return {
    kind: "measured",
    ms: own.ms,
    samples: ms.length,
    medianMs: med,
    minMs: Math.min(...ms),
    maxMs: Math.max(...ms),
    deltaMs: own.ms - med,
    ...(med > 0 && { ratio: own.ms / med }),
    faster: ms.filter((x) => x < own.ms).length,
    slower: ms.filter((x) => x > own.ms).length,
    caveats,
  };
}

/** How a run ended, for counting and charting: success or neutral; failure or timeout; cancelled; still running. */
export type Outcome = "succeeded" | "failed" | "cancelled" | "in progress" | "other";

export function outcomeOf(run: Pick<Run, "status" | "conclusion">): Outcome {
  const s = jobStatus(run);
  if (SUCCEEDED.has(s)) return "succeeded";
  if (s === "failure" || s === "timed_out") return "failed";
  if (s === "cancelled") return "cancelled";
  if (s === "in_progress" || s === "queued" || s === "waiting") return "in progress";
  return "other";
}

export type Outcomes = { runs: number } & Record<Outcome, number>;

/** Outcomes of the given runs of one workflow (each run attempt once); `runs` is the sample count. */
export function outcomes(runs: HistoryRun[], reference?: Run): Outcomes {
  const counts: Outcomes = { runs: 0, succeeded: 0, failed: 0, cancelled: 0, "in progress": 0, other: 0 };
  for (const r of comparable(runs, reference).kept) {
    counts.runs++;
    counts[outcomeOf(r.run)]++;
  }
  return counts;
}

export type ChartPoint = TrendPoint & { index: number; outcome: Outcome };
/**
 * Trend points for a chart, oldest first, each at its position in the series. Measured points carry their
 * duration; unmeasured ones keep their slot and reason and are never given a height. `maxMs` is undefined when no
 * point is measured.
 */
export function chartSeries(trend: Trend): { points: ChartPoint[]; measured: number; maxMs?: number } {
  const points = trend.points.map((p, index) => ({ ...p, index, outcome: outcomeOf(p) }));
  const ms = points.flatMap((p) => ("ms" in p.duration ? [p.duration.ms] : []));
  return { points, measured: ms.length, ...(ms.length && { maxMs: Math.max(...ms) }) };
}
