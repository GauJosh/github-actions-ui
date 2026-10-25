// Failure impact: where a run attempt failed, what led to each failure, and what did not run because of it.
// Pure: no I/O. Built from the run graph only (GitHub's job results and the workflow file's `needs:`).
//
// Facts, GitHub's rules and unknowns are kept apart:
// - a failure is a job GitHub reported as failed, timed out or cancelled (fact);
// - upstream is a failed job's ancestors through `needs:` edges read from the workflow file. No edge is inferred
//   from timing or order;
// - "not run because of it" (blocked): a skipped job whose `if:` has no status function, at least one of whose
//   needs failed or was itself blocked. GitHub then applies `success()`, so this follows from its rules;
// - "possibly": a skipped job whose own `if:` uses always(), failure(), cancelled() or success(), or that sits
//   below one. Its condition decided, and the data does not say how it evaluated;
// - "ran anyway" and "ran because of the failure": downstream jobs that ran despite it. Nothing below them is
//   attributed to the failure;
// - a skipped job that is not downstream of any failure is never counted as impact (it was skipped by its own
//   condition or for a reason the data does not show);
// - the earliest failure is the earliest by completion time: an observed order, never called the root cause.
import { jobStatus, type GraphNode, type NodeStatus, type RunGraph } from "../graph/build";
import type { Job, Run, Step } from "../types";

export type FailureKind = "failure" | "timed_out" | "cancelled";

/** A failed (or timed-out, or cancelled) job in a failure node, with the step GitHub reports as failed. */
export type FailedJob = { job: Job; label: string; kind: FailureKind; step?: Step; at?: string };

export type DownstreamReason =
  /** Skipped, by GitHub's default `success()` check: a need failed or was itself blocked. */
  | "blocked"
  /** Skipped, but a status function in its condition (or one above it) decided; the data does not say how. */
  | "possibly"
  /** Ran even though something it needs failed (its condition allows that). */
  | "ran-anyway"
  /** Ran because something it needs failed (its condition reacts to failure, e.g. a rollback). */
  | "recovery"
  | "cancelled"
  /** Not finished yet. */
  | "pending";

export type DownstreamJob = { key: string; reason: DownstreamReason; /** The needs on the failure's path. */ via: string[]; condition?: string };

export type Failure = {
  key: string;
  label: string;
  status: NodeStatus;
  kind: FailureKind;
  jobs: FailedJob[];
  /** Earliest completion of a failed job (or its failed step) in the node. */
  at?: string;
  /** Ancestors through `needs:`, nearest first, and those among them that failed. */
  upstream: string[];
  failedUpstream: string[];
  downstream: DownstreamJob[];
  /** Jobs declared in the workflow file that need something on this failure's path, with no job in this attempt. */
  declaredDownstream: string[];
  /** "from->to" for every edge on this failure's upstream and downstream paths. */
  edges: string[];
  /** The node has no known dependencies (not matched to the workflow file, or no workflow file). */
  untraced: boolean;
};

export type Impact = {
  failures: Failure[];
  /** The failure that completed first, by timestamp (`tied`: others at the same second). */
  earliest?: { key: string; job: Job; at: string; tied: string[] };
  dependencies: "workflow-file" | "unavailable";
  /** Skipped jobs that are downstream of no failure: not impact. */
  unrelatedSkipped: string[];
  /** What cannot be established from the data. */
  notes: string[];
};

const FAILED: NodeStatus[] = ["failure", "timed_out"];
const STOPPED: NodeStatus[] = [...FAILED, "cancelled"];
const RAN: NodeStatus[] = ["success", "neutral", "failure", "timed_out"];
const STATUS_FUNCTION = /\b(always|failure|cancelled|success)\s*\(\s*\)/;
const REACTS_TO_FAILURE = /\bfailure\s*\(\s*\)|\.result\s*==\s*['"]failure['"]/;

/** A condition that replaces GitHub's default `success()` check (so a failed need does not by itself skip the job). */
export const hasStatusFunction = (condition: string | undefined): boolean => !!condition && STATUS_FUNCTION.test(condition);

const edgeId = (from: string, to: string) => `${from}->${to}`;

function failedJobs(node: GraphNode): FailedJob[] {
  const out: FailedJob[] = [];
  for (const m of node.members) {
    const s = jobStatus(m.job);
    if (s !== "failure" && s !== "timed_out" && s !== "cancelled") continue;
    const step = m.job.steps?.find((x) => x.status === "completed" && (x.conclusion === "failure" || x.conclusion === "timed_out" || x.conclusion === "cancelled"));
    out.push({ job: m.job, label: m.label, kind: s, step, at: step?.completed_at ?? m.job.completed_at ?? undefined });
  }
  return out;
}

const earliestOf = (times: (string | undefined)[]) => times.filter((t): t is string => !!t).sort()[0];

/** Topological order of the graph's nodes (nodes in a cycle, which a valid workflow cannot have, go last). */
function topoOrder(graph: RunGraph): string[] {
  const indeg = new Map(graph.nodes.map((n) => [n.key, 0]));
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!indeg.has(e.from) || !indeg.has(e.to)) continue;
    indeg.set(e.to, indeg.get(e.to)! + 1);
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  }
  const queue = graph.nodes.filter((n) => indeg.get(n.key) === 0).map((n) => n.key);
  const order: string[] = [];
  while (queue.length) {
    const k = queue.shift()!;
    order.push(k);
    for (const t of out.get(k) ?? []) {
      indeg.set(t, indeg.get(t)! - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  for (const n of graph.nodes) if (!order.includes(n.key)) order.push(n.key);
  return order;
}

export function analyzeImpact(graph: RunGraph, run?: Pick<Run, "status" | "conclusion">): Impact {
  const nodes = new Map(graph.nodes.map((n) => [n.key, n]));
  const parents = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    (parents.get(e.to) ?? parents.set(e.to, []).get(e.to)!).push(e.from);
  }
  const order = topoOrder(graph);
  const withFile = graph.evidence.kind === "workflow-file";

  function ancestorsOf(key: string): string[] {
    const seen = new Set<string>();
    let frontier = [key];
    const out: string[] = [];
    while (frontier.length) {
      const next: string[] = [];
      for (const k of frontier)
        for (const p of parents.get(k) ?? [])
          if (!seen.has(p)) {
            seen.add(p);
            out.push(p);
            next.push(p);
          }
      frontier = next;
    }
    return out;
  }

  const failures: Failure[] = [];
  for (const node of graph.nodes) {
    if (!STOPPED.includes(node.status) || node.external) continue;
    const jobs = failedJobs(node);
    const upstream = ancestorsOf(node.key);
    const upSet = new Set([node.key, ...upstream]);
    const edges = graph.edges.filter((e) => upSet.has(e.from) && upSet.has(e.to)).map((e) => edgeId(e.from, e.to));

    // Downstream, in topological order: a node is on this failure's path when a need of it is.
    const onPath = new Map<string, boolean>([[node.key, true]]); // key -> attribution is certain
    const downstream: DownstreamJob[] = [];
    const start = order.indexOf(node.key);
    for (const k of order.slice(start + 1)) {
      const via = (parents.get(k) ?? []).filter((p) => onPath.has(p));
      if (!via.length) continue;
      const n = nodes.get(k)!;
      const certain = via.some((p) => onPath.get(p));
      let reason: DownstreamReason;
      if (n.status === "skipped" || n.status === "not_run") reason = certain && !hasStatusFunction(n.condition) ? "blocked" : "possibly";
      else if (RAN.includes(n.status)) reason = n.onFailure || REACTS_TO_FAILURE.test(n.condition ?? "") ? "recovery" : "ran-anyway";
      else if (n.status === "cancelled") reason = "cancelled";
      else if (n.status === "unknown") continue;
      else reason = "pending";
      downstream.push({ key: k, reason, via, ...(n.condition && { condition: n.condition }) });
      for (const p of via) edges.push(edgeId(p, k));
      // Only jobs that did not run carry the failure further down.
      if (reason === "blocked" || reason === "possibly") onPath.set(k, reason === "blocked");
    }

    const pathYaml = new Map<string, string>();
    for (const k of onPath.keys()) {
      const n = nodes.get(k)!;
      if (n.yamlId) pathYaml.set(`${(n.context?.path ?? []).join("/")}\u0000${n.yamlId}`, k);
    }
    const declaredDownstream = (graph.declared ?? [])
      .filter((d) => d.needs.some((need) => pathYaml.has(`${(d.context?.path ?? []).join("/")}\u0000${need}`)))
      .map((d) => [...(d.context?.labels ?? []), d.label].join(" › "));

    failures.push({
      key: node.key,
      label: node.label,
      status: node.status,
      kind: node.status === "cancelled" ? "cancelled" : node.status === "timed_out" ? "timed_out" : "failure",
      jobs,
      at: earliestOf(jobs.filter((j) => j.kind !== "cancelled").map((j) => j.at)) ?? earliestOf(jobs.map((j) => j.at)),
      upstream,
      failedUpstream: upstream.filter((k) => STOPPED.includes(nodes.get(k)!.status)),
      downstream,
      declaredDownstream,
      edges: [...new Set(edges)],
      untraced: !withFile || node.source === "job-name",
    });
  }
  // Failures (failed or timed out) first, by when they happened; cancellations after them.
  failures.sort((a, b) => Number(a.kind === "cancelled") - Number(b.kind === "cancelled") || (a.at ?? "￿").localeCompare(b.at ?? "￿"));

  let earliest: Impact["earliest"];
  const timed = failures.flatMap((f) => f.jobs.filter((j) => j.kind !== "cancelled" && j.at).map((j) => ({ key: f.key, job: j.job, at: j.at! })));
  if (timed.length) {
    timed.sort((a, b) => a.at.localeCompare(b.at));
    const first = timed[0]!;
    const second = (t: string) => t.slice(0, 19);
    const tied = [...new Set(timed.filter((t) => t.key !== first.key && second(t.at) === second(first.at)).map((t) => t.key))];
    earliest = { key: first.key, job: first.job, at: first.at, tied };
  }

  const impacted = new Set(failures.flatMap((f) => f.downstream.map((d) => d.key)));
  const unrelatedSkipped = graph.nodes.filter((n) => n.status === "skipped" && !impacted.has(n.key) && !n.external).map((n) => n.key);

  const notes: string[] = [];
  if (!withFile) {
    notes.push(
      `Dependencies are unavailable (${graph.evidence.kind === "unavailable" ? graph.evidence.reason.replace(/\.$/, "") : "no workflow file"}), so upstream paths and downstream impact cannot be established. Only the failed jobs are shown.`,
    );
  }
  const untraced = failures.filter((f) => f.untraced && withFile);
  if (untraced.length) {
    notes.push(`${untraced.map((f) => `“${f.label}”`).join(", ")} could not be matched to the workflow file, so ${untraced.length === 1 ? "its" : "their"} dependencies are unknown.`);
  }
  if (failures.some((f) => nodes.get(f.key)!.kind === "reusable" && nodes.get(f.key)!.callId)) {
    notes.push("A called (reusable) workflow shown as one node lists which of its jobs failed, but dependencies between its own jobs are not traced here; open the call to see them.");
  }
  if (failures.some((f) => f.downstream.some((d) => d.reason === "possibly"))) {
    notes.push("“Possibly” means a condition with always(), failure(), cancelled() or success(), on the job or on a skipped job above it, decided whether it ran. GitHub does not report how a condition evaluated.");
  }
  if (failures.some((f) => f.jobs.some((j) => j.kind !== "cancelled") && f.jobs.some((j) => j.kind === "cancelled"))) {
    notes.push("Some matrix jobs were cancelled alongside a failure. A matrix's fail-fast setting cancels the remaining jobs, but GitHub does not report why a job was cancelled.");
  }
  if (failures.some((f) => f.kind === "cancelled")) {
    notes.push("GitHub does not report why a job was cancelled (a manual cancel, a newer run in the same concurrency group, or matrix fail-fast can each cause it).");
  }
  if (run && run.status !== "completed") notes.push("The run is still in progress: more jobs may fail, and jobs not created yet cannot be shown.");
  if (run?.status === "completed" && run.conclusion === "failure" && failures.length === 0) {
    notes.push("GitHub reports the run as failed, but no job in this attempt failed (for example a workflow file error or a startup failure), so there is no job to trace.");
  }
  return { failures, earliest, dependencies: withFile ? "workflow-file" : "unavailable", unrelatedSkipped, notes };
}

/** Plain-language reason for a downstream job, for the UI. */
export const DOWNSTREAM_TEXT: Record<DownstreamReason, string> = {
  blocked: "Not run because of it",
  possibly: "Possibly not run because of it",
  "ran-anyway": "Ran anyway",
  recovery: "Ran because of the failure",
  cancelled: "Cancelled",
  pending: "Not finished",
};
