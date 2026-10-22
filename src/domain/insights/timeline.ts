// Execution timeline: one row per job on a shared time axis, from the timestamps GitHub reported. Pure: no I/O.
//
// - A bar runs from `started_at` to `completed_at`. A job still running has no end: its bar is open and drawn to
//   the latest timestamp in the run, marked as running. Nothing is extrapolated from the current time.
// - Queue time (`created_at` → `started_at`, when GitHub reports `created_at`) is drawn separately and never
//   counted as execution.
// - Jobs that never started (skipped, queued, waiting) or that completed without timestamps get no bar; they are
//   listed with the reason, so the chart never implies a time it does not have.
// - Rows are grouped by the release overview's phases (environments) when there is one, else by the top-level
//   reusable-workflow call, else in one group. Groups are ordered by their first start.
import { jobStatus, type GraphNode, type NodeStatus, type RunGraph } from "../graph/build";
import type { Job } from "../types";

export type TimelineRow = {
  job: Job;
  /** The graph node the job belongs to, for dependencies and navigation. */
  nodeKey?: string;
  status: NodeStatus;
  /** Milliseconds from the axis start. */
  start?: number;
  end?: number;
  queuedFrom?: number;
  /** Why there is no bar, or why it is open-ended. */
  timing: "complete" | "running" | "not-started" | "skipped" | "missing";
};
export type TimelineGroup = { id: string; label: string; rows: TimelineRow[] };
export type Timeline = {
  /** Axis start (epoch ms) and length. Undefined when no job has started. */
  origin?: number;
  span: number;
  groups: TimelineGroup[];
  /** Dependencies between jobs (by job id), from the graph's edges between their nodes. */
  edges: { from: number; to: number }[];
  /** How rows were grouped. */
  grouping: "phases" | "calls" | "none";
};

const t = (iso?: string | null) => (iso ? Date.parse(iso) : NaN);

export function buildTimeline(jobs: Job[], graph?: RunGraph | null, phases?: { id: string; name: string; nodeKeys: string[] }[]): Timeline {
  const nodeOf = new Map<number, GraphNode>();
  for (const n of graph?.nodes ?? []) for (const m of n.members) nodeOf.set(m.job.id, n);
  const starts = jobs.map((j) => t(j.started_at)).filter(Number.isFinite);
  const origin = starts.length ? Math.min(...starts) : undefined;
  const latest = Math.max(...jobs.flatMap((j) => [t(j.started_at), t(j.completed_at)]).filter(Number.isFinite));
  const span = origin !== undefined && Number.isFinite(latest) ? Math.max(1, latest - origin) : 0;

  const rows: TimelineRow[] = jobs.map((job) => {
    const status = jobStatus(job);
    const node = nodeOf.get(job.id);
    const s = t(job.started_at);
    const e = t(job.completed_at);
    const c = t(job.created_at);
    const base = { job, status, ...(node && { nodeKey: node.key }) };
    if (status === "skipped") return { ...base, timing: "skipped" };
    if (!Number.isFinite(s) || origin === undefined) return { ...base, timing: job.status === "completed" ? "missing" : "not-started" };
    const queued = Number.isFinite(c) && c < s ? { queuedFrom: Math.max(0, c - origin) } : {};
    if (job.status !== "completed") return { ...base, ...queued, start: s - origin, end: span, timing: "running" };
    if (!Number.isFinite(e) || e < s) return { ...base, timing: "missing" };
    return { ...base, ...queued, start: s - origin, end: e - origin, timing: "complete" };
  });

  // Grouping.
  let grouping: Timeline["grouping"] = "none";
  const groupOf = new Map<number, { id: string; label: string }>();
  const phaseOf = new Map<string, { id: string; name: string }>();
  for (const p of phases ?? []) for (const k of p.nodeKeys) phaseOf.set(k, p);
  for (const r of rows) {
    const node = r.nodeKey ? graph?.nodes.find((n) => n.key === r.nodeKey) : undefined;
    const phase = r.nodeKey ? phaseOf.get(r.nodeKey) : undefined;
    if (phase) {
      grouping = "phases";
      groupOf.set(r.job.id, { id: `phase:${phase.id}`, label: phase.name });
    } else if (node?.context) {
      if (grouping === "none") grouping = "calls";
      groupOf.set(r.job.id, { id: `call:${node.context.path[0]}`, label: node.context.labels[0]! });
    }
  }
  const groups = new Map<string, TimelineGroup>();
  for (const r of rows) {
    const g = groupOf.get(r.job.id) ?? (grouping === "none" ? { id: "all", label: "Jobs" } : { id: "other", label: "Other jobs" });
    (groups.get(g.id) ?? groups.set(g.id, { ...g, rows: [] }).get(g.id)!).rows.push(r);
  }
  const first = (g: TimelineGroup) => Math.min(...g.rows.map((r) => r.start ?? Infinity));
  const byStart = (a: TimelineRow, b: TimelineRow) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.job.id - b.job.id;
  const ordered = [...groups.values()].map((g) => ({ ...g, rows: g.rows.sort(byStart) })).sort((a, b) => first(a) - first(b) || (phases ? 0 : a.label.localeCompare(b.label)));

  // Dependencies between jobs: every member of a node needs every member of the nodes it depends on.
  const members = new Map((graph?.nodes ?? []).map((n) => [n.key, n.members.map((m) => m.job.id)]));
  const edges: Timeline["edges"] = [];
  for (const e of graph?.edges ?? []) for (const a of members.get(e.from) ?? []) for (const b of members.get(e.to) ?? []) edges.push({ from: a, to: b });

  return { origin, span, groups: ordered, edges, grouping };
}

/** Axis ticks at a readable step for the span. */
export function ticks(span: number, target = 8): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400].map((s) => s * 1000);
  const step = steps.find((s) => span / s <= target) ?? steps.at(-1)!;
  const out: number[] = [];
  for (let x = 0; x <= span; x += step) out.push(x);
  return out;
}
