// Run-to-run comparison: two executions (attempts of one run, or runs of a workflow), each from its own data
// only. Pure: no I/O.
//
// Rules:
// - each side is one attempt: its run object, that attempt's jobs, and the graph built from them. A job GitHub lists
//   in the attempt but reports as run in another attempt is called out, never silently treated as this attempt's;
// - jobs are matched by workflow identity: the job id in the workflow file (and, inside reusable calls, the call
//   path), plus the matrix values or the called job's name. Only when a side has no workflow file are jobs matched
//   by name, and that is labelled. Two unmatched jobs with the same steps are offered as a possible rename, not
//   merged;
// - "not available" is never shown as a difference: a missing log, file or timestamp is reported as missing;
// - a commit that is only in one side is listed as a change between the two, never as a cause.
import { durationMs, jobStatus, type GraphNode, type NodeStatus, type RunGraph } from "../graph/build";
import type { Job, Run, Step } from "../types";
import { diffSequences, type DiffResult } from "./diff";
import { identities, nodeIdentity } from "./identity";

export type Side = {
  run: Run;
  /** The attempt this side shows (explicit, even when it is the latest). */
  attempt: number;
  jobs: Job[];
  graph: RunGraph | null;
  /** The workflow file at the run's commit; null when it could not be read. */
  workflowText?: string | null;
};

export type MatchBasis = "workflow-file" | "name" | "possible-rename";

export type StepChange = "same" | "outcome" | "added" | "removed";
export type StepDiff = { name: string; base?: Step; head?: Step; change: StepChange };

export type DurationDiff = { base?: number; head?: number; delta?: number; ratio?: number; comparable: boolean; why?: string; trend?: "slower" | "faster" };

export type JobChange = "same" | "outcome" | "added" | "removed";
export type JobDiff = {
  key: string;
  label: string;
  basis: MatchBasis;
  base?: Job;
  head?: Job;
  baseStatus?: NodeStatus;
  headStatus?: NodeStatus;
  change: JobChange;
  /** The job's display name changed while its workflow identity stayed the same. */
  renamed?: { from: string; to: string };
  duration: DurationDiff;
  steps: StepDiff[];
  /** The head side's graph node, for navigation. */
  headNode?: string;
  notes: string[];
};

export type EnvDiff = { environment: string; base?: NodeStatus; head?: NodeStatus };

export type RunComparison = {
  sameExecution: boolean;
  comparable: { ok: boolean; reasons: string[] };
  conclusion: { base: string | null; head: string | null; changed: boolean };
  duration: DurationDiff;
  jobs: JobDiff[];
  counts: { outcome: number; added: number; removed: number; slower: number; faster: number; nowFailing: number; nowPassing: number };
  graph: { available: boolean; why?: string; addedJobs: string[]; removedJobs: string[]; addedEdges: [string, string][]; removedEdges: [string, string][] };
  workflow: {
    samePath: boolean;
    sameCommit: boolean;
    file: "same" | "changed" | "unavailable";
    diff?: DiffResult;
    called: { path: string; base?: string; head?: string }[];
  };
  environments: EnvDiff[];
  notes: string[];
  summary: string[];
};

const RAN = new Set<NodeStatus>(["success", "failure", "timed_out", "neutral"]);
const FAILING = new Set<NodeStatus>(["failure", "timed_out", "cancelled"]);
/** A job duration change is reported when it is at least this large, both absolutely and relative to the baseline. */
export const REGRESSION = { minMs: 30_000, minRatio: 1.25 };

function jobDuration(job: Job | undefined): number | undefined {
  if (!job || job.status !== "completed") return undefined;
  return durationMs(job.started_at, job.completed_at);
}

export function compareDuration(base: number | undefined, head: number | undefined, why?: string): DurationDiff {
  if (why) return { base, head, comparable: false, why };
  if (base === undefined || head === undefined) return { base, head, comparable: false, why: "timing is missing on one side" };
  const delta = head - base;
  const ratio = base > 0 ? head / base : undefined;
  const trend =
    Math.abs(delta) >= REGRESSION.minMs && ratio !== undefined && (ratio >= REGRESSION.minRatio || ratio <= 1 / REGRESSION.minRatio) ? (delta > 0 ? "slower" : "faster") : undefined;
  return { base, head, delta, ratio, comparable: true, ...(trend && { trend }) };
}

/** Steps matched by name, and by occurrence for repeated names. */
export function compareSteps(base: Step[] | undefined, head: Step[] | undefined): StepDiff[] {
  // A job with no steps (skipped, or no step data) has nothing to compare step by step.
  if (!base?.length || !head?.length) return [];
  const keyed = (steps: Step[]) => {
    const seen = new Map<string, number>();
    return steps.map((s) => {
      const n = (seen.get(s.name) ?? 0) + 1;
      seen.set(s.name, n);
      return { key: `${s.name}\u0000${n}`, step: s };
    });
  };
  const b = keyed(base);
  const h = new Map(keyed(head).map((x) => [x.key, x.step]));
  const out: StepDiff[] = [];
  const used = new Set<string>();
  for (const { key, step } of b) {
    const other = h.get(key);
    used.add(key);
    if (!other) out.push({ name: step.name, base: step, change: "removed" });
    else out.push({ name: step.name, base: step, head: other, change: jobStatus(step) === jobStatus(other) ? "same" : "outcome" });
  }
  for (const { key, step } of keyed(head)) if (!used.has(key)) out.push({ name: step.name, head: step, change: "added" });
  return out;
}

function wallClock(jobs: Job[]): number | undefined {
  if (!jobs.length || jobs.some((j) => j.status !== "completed")) return undefined;
  const starts = jobs.map((j) => j.started_at).filter((t): t is string => !!t).sort();
  const ends = jobs.map((j) => j.completed_at).filter((t): t is string => !!t).sort();
  return durationMs(starts[0], ends.at(-1));
}

function envStatuses(graph: RunGraph | null): Map<string, NodeStatus> {
  const order: NodeStatus[] = ["failure", "timed_out", "cancelled", "in_progress", "waiting", "queued", "unknown", "success", "neutral", "skipped", "not_run"];
  const out = new Map<string, NodeStatus>();
  for (const n of graph?.nodes ?? []) {
    if (!n.environment) continue;
    const cur = out.get(n.environment);
    if (!cur || order.indexOf(n.status) < order.indexOf(cur)) out.set(n.environment, n.status);
  }
  return out;
}

function edgeIds(graph: RunGraph): { nodes: Map<string, string>; edges: Set<string> } {
  const nodes = new Map<string, string>(); // identity -> label
  const byKey = new Map<string, string>();
  for (const n of graph.nodes) {
    const id = nodeIdentity(n);
    if (!id) continue;
    nodes.set(id, n.label);
    byKey.set(n.key, id);
  }
  // Declared jobs with no job in the run are part of the definition too.
  for (const d of graph.declared ?? []) nodes.set([...(d.context?.path ?? []), d.id].join("/"), d.label);
  const edges = new Set<string>();
  for (const e of graph.edges) {
    const f = byKey.get(e.from);
    const t = byKey.get(e.to);
    if (f && t) edges.add(`${f}\u0000${t}`);
  }
  return { nodes, edges };
}

export function compareRuns(base: Side, head: Side): RunComparison {
  const notes: string[] = [];
  const reasons: string[] = [];
  const sameExecution = base.run.id === head.run.id && base.attempt === head.attempt;
  if (sameExecution) reasons.push("Both sides are the same attempt of the same run.");
  if ((base.run.workflow_id !== undefined && head.run.workflow_id !== undefined && base.run.workflow_id !== head.run.workflow_id) || base.run.path !== head.run.path) {
    reasons.push("The runs are of different workflows, so their jobs are not expected to correspond.");
  }
  for (const [label, s] of [
    ["baseline", base],
    ["this run", head],
  ] as const) {
    if (s.run.status !== "completed") notes.push(`The ${label} is still in progress: its results and timings are not final.`);
    const carried = s.jobs.filter((j) => j.run_attempt !== undefined && j.run_attempt !== s.attempt);
    if (carried.length) {
      notes.push(
        `GitHub lists ${carried.length} job${carried.length === 1 ? "" : "s"} in attempt ${s.attempt} of the ${label} that it reports as run in another attempt; they are compared as listed, and labelled.`,
      );
    }
    if (!s.graph || s.graph.evidence.kind !== "workflow-file") notes.push(`The ${label}'s workflow file was not available, so its jobs are matched by name only.`);
  }
  if (base.run.event !== head.run.event) notes.push(`The runs were triggered differently (${base.run.event} and ${head.run.event}).`);
  if ((base.run.head_branch ?? "") !== (head.run.head_branch ?? "")) notes.push(`The runs are on different branches (${base.run.head_branch ?? "none"} and ${head.run.head_branch ?? "none"}).`);

  // ---- jobs ----
  const bIds = identities(base);
  const hIds = identities(head);
  const hByKey = new Map<string, Job[]>();
  for (const j of head.jobs) {
    const k = hIds.get(j.id)!.key;
    (hByKey.get(k) ?? hByKey.set(k, []).get(k)!).push(j);
  }
  const jobs: JobDiff[] = [];
  const usedHead = new Set<number>();
  const unmatchedBase: Job[] = [];
  for (const bj of base.jobs) {
    const id = bIds.get(bj.id)!;
    const candidates = (hByKey.get(id.key) ?? []).filter((j) => !usedHead.has(j.id));
    const hj = candidates[0];
    if (!hj) {
      unmatchedBase.push(bj);
      continue;
    }
    usedHead.add(hj.id);
    const hid = hIds.get(hj.id)!;
    jobs.push(pair(id.key, hid.label, hid.basis === "name" || id.basis === "name" ? "name" : "workflow-file", bj, hj, hid.node));
  }
  const unmatchedHead = head.jobs.filter((j) => !usedHead.has(j.id));
  // A side without a workflow file has name identities only: match the rest by job name, labelled as such.
  for (const bj of [...unmatchedBase]) {
    const hj = unmatchedHead.find((j) => j.name === bj.name);
    if (!hj) continue;
    unmatchedBase.splice(unmatchedBase.indexOf(bj), 1);
    unmatchedHead.splice(unmatchedHead.indexOf(hj), 1);
    jobs.push(pair(`name:${bj.name}`, bj.name, "name", bj, hj, hIds.get(hj.id)!.node));
  }
  // Same steps, different identity: offered as a possible rename, kept as separate jobs otherwise.
  const stepNames = (j: Job) => (j.steps ?? []).map((s) => s.name).join("\u0000");
  const meaningful = (j: Job) => (j.steps?.length ?? 0) >= 3;
  for (const bj of [...unmatchedBase]) {
    const cands = unmatchedHead.filter((hj) => meaningful(bj) && meaningful(hj) && stepNames(hj) === stepNames(bj));
    const sameBase = unmatchedBase.filter((x) => stepNames(x) === stepNames(bj));
    if (cands.length !== 1 || sameBase.length !== 1) continue;
    const hj = cands[0]!;
    unmatchedBase.splice(unmatchedBase.indexOf(bj), 1);
    unmatchedHead.splice(unmatchedHead.indexOf(hj), 1);
    const d = pair(`rename:${bj.id}:${hj.id}`, hIds.get(hj.id)!.label, "possible-rename", bj, hj, hIds.get(hj.id)!.node);
    d.notes.push(`Possibly the same job renamed from “${bj.name}”: the workflow identity differs, but the steps are the same. Not certain.`);
    jobs.push(d);
  }
  for (const bj of unmatchedBase) {
    const id = bIds.get(bj.id)!;
    jobs.push({ key: id.key, label: id.label, basis: id.basis, base: bj, baseStatus: jobStatus(bj), change: "removed", duration: compareDuration(jobDuration(bj), undefined, "not in this run"), steps: [], notes: [] });
  }
  for (const hj of unmatchedHead) {
    const id = hIds.get(hj.id)!;
    jobs.push({
      key: id.key,
      label: id.label,
      basis: id.basis,
      head: hj,
      headStatus: jobStatus(hj),
      change: "added",
      duration: compareDuration(undefined, jobDuration(hj), "not in the baseline"),
      steps: [],
      headNode: id.node?.key,
      notes: [],
    });
  }

  function pair(key: string, label: string, basis: MatchBasis, bj: Job, hj: Job, node?: GraphNode): JobDiff {
    const bs = jobStatus(bj);
    const hs = jobStatus(hj);
    const jobNotes: string[] = [];
    let why: string | undefined;
    if (!RAN.has(bs) || !RAN.has(hs)) why = "the job did not run to completion on both sides";
    const stoppedEarly = bs !== hs && (FAILING.has(bs) || FAILING.has(hs));
    if (stoppedEarly && !why) jobNotes.push("One side failed, so it may have stopped early: the durations measure different work and are not counted as slower or faster.");
    const labels = (j: Job) => (j.labels ?? []).join(",");
    if (bj.labels && hj.labels && labels(bj) !== labels(hj)) jobNotes.push(`Different runner labels (${labels(bj) || "none"} and ${labels(hj) || "none"}).`);
    if (hj.run_attempt !== undefined && hj.run_attempt !== head.attempt) jobNotes.push(`In this run, GitHub reports this job as run in attempt ${hj.run_attempt}.`);
    if (bj.run_attempt !== undefined && bj.run_attempt !== base.attempt) jobNotes.push(`In the baseline, GitHub reports this job as run in attempt ${bj.run_attempt}.`);
    return {
      key,
      label,
      basis,
      base: bj,
      head: hj,
      baseStatus: bs,
      headStatus: hs,
      change: bs === hs ? "same" : "outcome",
      ...(bj.name !== hj.name && basis !== "possible-rename" && { renamed: { from: bj.name, to: hj.name } }),
      duration: stoppedEarly && !why ? { ...compareDuration(jobDuration(bj), jobDuration(hj)), trend: undefined } : compareDuration(jobDuration(bj), jobDuration(hj), why),
      steps: compareSteps(bj.steps, hj.steps),
      headNode: node?.key,
      notes: jobNotes,
    };
  }
  const rank: Record<JobChange, number> = { outcome: 0, added: 1, removed: 2, same: 3 };
  jobs.sort((a, b) => rank[a.change] - rank[b.change]);

  // ---- graph ----
  let graph: RunComparison["graph"];
  if (base.graph?.evidence.kind === "workflow-file" && head.graph?.evidence.kind === "workflow-file") {
    const b = edgeIds(base.graph);
    const h = edgeIds(head.graph);
    const split = (e: string) => e.split("\u0000") as [string, string];
    graph = {
      available: true,
      addedJobs: [...h.nodes.keys()].filter((k) => !b.nodes.has(k)),
      removedJobs: [...b.nodes.keys()].filter((k) => !h.nodes.has(k)),
      addedEdges: [...h.edges].filter((e) => !b.edges.has(e)).map(split),
      removedEdges: [...b.edges].filter((e) => !h.edges.has(e)).map(split),
    };
  } else {
    graph = { available: false, why: "Dependencies come from the workflow file, which is not available for both runs.", addedJobs: [], removedJobs: [], addedEdges: [], removedEdges: [] };
  }

  // ---- workflow file and called workflows ----
  const bt = base.workflowText;
  const ht = head.workflowText;
  const file: RunComparison["workflow"]["file"] = typeof bt !== "string" || typeof ht !== "string" ? "unavailable" : bt === ht ? "same" : "changed";
  const calledPaths = new Map<string, { base?: string; head?: string }>();
  const strip = (p: string) => p.replace(/@[^@]*$/, "");
  for (const r of base.run.referenced_workflows ?? []) calledPaths.set(strip(r.path), { ...calledPaths.get(strip(r.path)), base: r.sha });
  for (const r of head.run.referenced_workflows ?? []) calledPaths.set(strip(r.path), { ...calledPaths.get(strip(r.path)), head: r.sha });
  const workflow: RunComparison["workflow"] = {
    samePath: base.run.path === head.run.path,
    sameCommit: base.run.head_sha === head.run.head_sha,
    file,
    ...(file === "changed" && { diff: diffSequences(bt!.split("\n"), ht!.split("\n"), 1000) }),
    called: [...calledPaths].filter(([, v]) => v.base !== v.head).map(([path, v]) => ({ path, ...v })),
  };

  // ---- environments ----
  const be = envStatuses(base.graph);
  const he = envStatuses(head.graph);
  const environments = [...new Set([...be.keys(), ...he.keys()])].map((environment) => ({ environment, base: be.get(environment), head: he.get(environment) }));

  // ---- run level ----
  const runWhy = base.run.status !== "completed" || head.run.status !== "completed" ? "a run is still in progress" : undefined;
  // As for jobs: when one run failed or was cancelled, the durations measure different work, so no trend.
  const runStoppedEarly = base.run.conclusion !== head.run.conclusion && [base, head].some((s) => FAILING.has(s.run.conclusion as NodeStatus));
  const runDuration = compareDuration(wallClock(base.jobs), wallClock(head.jobs), runWhy);
  const duration = runStoppedEarly ? { ...runDuration, trend: undefined } : runDuration;
  if (duration.comparable && (be.size || he.size)) notes.push("Run durations include any time spent waiting for deployment approvals.");

  const counts = {
    outcome: jobs.filter((j) => j.change === "outcome").length,
    added: jobs.filter((j) => j.change === "added").length,
    removed: jobs.filter((j) => j.change === "removed").length,
    slower: jobs.filter((j) => j.duration.trend === "slower").length,
    faster: jobs.filter((j) => j.duration.trend === "faster").length,
    nowFailing: jobs.filter((j) => j.change === "outcome" && FAILING.has(j.headStatus!) && !FAILING.has(j.baseStatus!)).length,
    nowPassing: jobs.filter((j) => j.change === "outcome" && j.headStatus === "success" && FAILING.has(j.baseStatus!)).length,
  };
  const conclusion = { base: base.run.conclusion, head: head.run.conclusion, changed: base.run.conclusion !== head.run.conclusion };

  const summary: string[] = [];
  summary.push(
    conclusion.changed
      ? `This run ${conclusionText(head.run)}; the baseline ${conclusionText(base.run)}.`
      : `Both runs ${conclusionText(head.run).replace(/^is /, "are ").replace(/^was /, "were ")}.`,
  );
  const parts = [
    counts.nowFailing && `${counts.nowFailing} job${counts.nowFailing === 1 ? "" : "s"} now fail${counts.nowFailing === 1 ? "s" : ""}`,
    counts.nowPassing && `${counts.nowPassing} now pass${counts.nowPassing === 1 ? "es" : ""}`,
    counts.outcome - counts.nowFailing - counts.nowPassing > 0 && `${counts.outcome - counts.nowFailing - counts.nowPassing} other outcome change${counts.outcome - counts.nowFailing - counts.nowPassing === 1 ? "" : "s"}`,
    counts.added && `${counts.added} job${counts.added === 1 ? "" : "s"} added`,
    counts.removed && `${counts.removed} removed`,
    counts.slower && `${counts.slower} notably slower`,
    counts.faster && `${counts.faster} notably faster`,
  ].filter(Boolean);
  summary.push(parts.length ? `${parts.join(", ")}.` : "No job changed outcome, and no job was added or removed.");
  if (workflow.file === "changed") summary.push("The workflow file differs between the two commits.");
  else if (workflow.file === "unavailable") summary.push("Whether the workflow file changed is unknown: it was not available for both runs.");
  if (workflow.called.length) summary.push(`${workflow.called.length} called workflow${workflow.called.length === 1 ? " resolved" : "s resolved"} to a different commit.`);
  if (!workflow.sameCommit && !sameExecution) summary.push("The runs are at different commits; a commit that appears only in one run is a difference between them, not a proven cause.");
  if (workflow.sameCommit && !sameExecution) summary.push("Both ran the same commit: differences come from something else (inputs, timing, the environment or an external service), which GitHub's API does not show.");

  return { sameExecution, comparable: { ok: reasons.length === 0, reasons }, conclusion, duration, jobs, counts, graph, workflow, environments, notes, summary };
}

function conclusionText(run: Run): string {
  if (run.status !== "completed") return `is ${run.status.replace("_", " ")}`;
  switch (run.conclusion) {
    case "success":
      return "succeeded";
    case "failure":
      return "failed";
    case "cancelled":
      return "was cancelled";
    case "timed_out":
      return "timed out";
    default:
      return `ended ${run.conclusion ?? "without a conclusion"}`;
  }
}
