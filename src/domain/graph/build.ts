// Builds a run's execution graph from evidence only. Pure: no I/O.
//
// Evidence used:
// - jobs, statuses and timestamps come from the GitHub jobs API;
// - dependency edges come ONLY from `needs:` in the run's own workflow file (fetched at the run's commit);
// - matrix and reusable-workflow grouping come from the workflow file, or, without it, from GitHub's job
//   naming conventions (clearly labelled as name-based);
// - jobs that cannot be matched to the workflow file are shown without edges.
// Nothing here infers an edge from timing or order.
import type { Job, Run } from "../types";
import { runsOnFailure, type WorkflowDefinition, type WorkflowJobDef, type WorkflowStepDef } from "./workflow-definition";

export type NodeStatus =
  | "failure"
  | "timed_out"
  | "cancelled"
  | "in_progress"
  | "waiting"
  | "queued"
  | "unknown"
  | "success"
  | "neutral"
  | "skipped"
  | "not_run";

const PRIORITY: NodeStatus[] = ["failure", "timed_out", "cancelled", "in_progress", "waiting", "queued", "unknown", "success", "neutral", "skipped", "not_run"];

export function jobStatus(job: Pick<Job, "status" | "conclusion">): NodeStatus {
  switch (job.status) {
    case "in_progress":
      return "in_progress";
    case "queued":
    case "requested":
    case "pending":
      return "queued";
    case "waiting":
      return "waiting";
    case "completed":
      switch (job.conclusion) {
        case "failure":
        case "startup_failure":
          return "failure";
        case "action_required":
          return "waiting";
        case "timed_out":
        case "cancelled":
        case "success":
        case "neutral":
        case "skipped":
          return job.conclusion;
        default:
          return "unknown";
      }
    default:
      return "unknown";
  }
}

/** `wholeCall`: GitHub reported the reusable-workflow call itself as one job (e.g. the call was skipped). */
export type GraphMember = { label: string; job: Job; wholeCall?: boolean };

/** Where the revision of a workflow file comes from. */
export type RevisionSource = "run-commit" | "referenced-workflows" | "pinned-sha" | "caller-commit";
export type WorkflowFileRef = { repo: string; path: string; revision: string; source: RevisionSource };

/** The chain of reusable-workflow calls a node sits in, from the run's own workflow down. */
export type NodeContext = {
  /** Call job ids, e.g. ["cd", "deploy-dev"]. */
  path: string[];
  /** Their display names, e.g. ["cd", "DEV"]. */
  labels: string[];
  /** The called workflow files, one per level, when they were read. */
  files: (WorkflowFileRef | undefined)[];
  /** A literal `environment` input passed by the innermost call (used only to match a declared environment). */
  environmentInput?: string;
  /** The innermost call's `with:` values that resolve to literals (from the caller's own literals). */
  inputs?: Record<string, string>;
};

export type GraphNode = {
  key: string;
  label: string;
  kind: "job" | "matrix" | "reusable";
  /** How the node was formed: from the run's workflow file, or from GitHub's job-name conventions only. */
  source: "workflow-file" | "job-name";
  yamlId?: string;
  /** Matrix legs or reusable-workflow inner jobs, with their distinguishing label. */
  members: GraphMember[];
  status: NodeStatus;
  counts: Partial<Record<NodeStatus, number>>;
  startedAt?: string;
  /** Set only when every job in the node has completed. */
  completedAt?: string;
  /** Reusable workflow call: the `uses:` value and, when GitHub reported it, the commit it resolved to. */
  uses?: string;
  resolvedWorkflow?: { path: string; sha: string };
  /** Declared in the workflow file but no job with this name exists in this run. */
  declaredOnly?: boolean;
  /** From the workflow file: the deployment environment the job targets. */
  environment?: string;
  /** From the workflow file: `if: failure()`, so the job runs only when something upstream failed. */
  onFailure?: boolean;
  /** Inside reusable-workflow calls: which calls, and which files at which revisions. Absent at the top level. */
  context?: NodeContext;
  /** A job's steps as written in its workflow file. */
  stepDefs?: WorkflowStepDef[];
  /** A reusable call shown as one node: the id of its context (call ids joined by "/"), to open it. */
  callId?: string;
  /** A reusable call: the called file and revision, or why it was not read. */
  callFile?: WorkflowFileRef;
  callUnavailable?: string;
  /** A reusable call: its `with:` values that resolve to literals. */
  callInputs?: Record<string, string>;
  /** The job (or a job in the called workflow) declares an environment that cannot be resolved from the run's data. */
  environmentUnresolved?: string;
  /** How `environment` was established: written in the file, or `${{ inputs.x }}` filled from the caller's literal `with:`. */
  environmentEvidence?: "declared" | "input";
  /** A stand-in for a node outside the current view (a phase detail shows its neighbours this way). */
  external?: { key: string; phaseId?: string; phaseName: string; direction?: "upstream" | "downstream"; jobs?: string[] };
};

/** `via: "call"`: a caller-level `needs` between reusable calls, drawn between the jobs inside them. */
export type GraphEdge = { from: string; to: string; via?: "call" };

export type GraphEvidence =
  | { kind: "workflow-file"; path: string; revision: string; matchedJobs: number; totalJobs: number; notes: string[] }
  | { kind: "unavailable"; reason: string; notes: string[] };

export type RunGraph = { nodes: GraphNode[]; edges: GraphEdge[]; evidence: GraphEvidence };

// ---- name matching --------------------------------------------------------------------------------

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EXPR = /\$\{\{[\s\S]*?\}\}/;

type Matcher = { def: WorkflowJobDef; regex: RegExp; exact: boolean; memberLabel(match: RegExpExecArray, job: Job): string };

function matcherFor(def: WorkflowJobDef): Matcher {
  const display = def.name ?? def.id;
  const templated = EXPR.test(display);
  const base = templated
    ? display
        .split(EXPR)
        .map(escape)
        .join(".+?")
    : escape(display);
  if (def.uses) {
    // GitHub names reusable-workflow jobs "<caller> / <called job>", with matrix values after the caller. A
    // call that did not run (e.g. skipped) is reported as one job named after the caller.
    return {
      def,
      regex: new RegExp(`^${base}(?: \\((.+?)\\))?(?: / (.+))?$`),
      exact: false,
      memberLabel: (m, job) => (m[2] ? (m[1] ? `${m[1]} / ${m[2]}` : m[2]) : job.name),
    };
  }
  if (def.matrix && !templated) {
    // Without matrix expressions in the name, GitHub appends the matrix values in parentheses.
    return { def, regex: new RegExp(`^${base}(?: \\((.+)\\))?$`), exact: false, memberLabel: (m, job) => m[1] ?? job.name };
  }
  return {
    def,
    regex: new RegExp(`^${base}$`),
    exact: !templated,
    memberLabel: (_m, job) => {
      const paren = /\((.+)\)$/.exec(job.name);
      return def.matrix && paren ? paren[1]! : job.name;
    },
  };
}

// ---- aggregation ----------------------------------------------------------------------------------

function summarize(node: Omit<GraphNode, "status" | "counts" | "startedAt" | "completedAt">): GraphNode {
  const counts: Partial<Record<NodeStatus, number>> = {};
  for (const { job } of node.members) {
    const s = jobStatus(job);
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const status = node.members.length ? PRIORITY.find((s) => counts[s]) ?? "unknown" : "not_run";
  const starts = node.members.map((m) => m.job.started_at).filter((t): t is string => !!t);
  const allDone = node.members.length > 0 && node.members.every((m) => m.job.status === "completed" && m.job.completed_at);
  const ends = node.members.map((m) => m.job.completed_at).filter((t): t is string => !!t);
  return {
    ...node,
    status,
    counts,
    startedAt: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : undefined,
    completedAt: allDone && ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : undefined,
  };
}

const byStart = (a: GraphNode, b: GraphNode) => (a.startedAt ?? "￿").localeCompare(b.startedAt ?? "￿");

// ---- without a workflow file ---------------------------------------------------------------------

function nameBasedNodes(jobs: Job[]): GraphNode[] {
  const reusable = new Map<string, GraphMember[]>();
  const matrix = new Map<string, GraphMember[]>();
  const single: Job[] = [];
  for (const job of jobs) {
    const slash = job.name.indexOf(" / ");
    if (slash > 0) {
      const key = job.name.slice(0, slash);
      reusable.set(key, [...(reusable.get(key) ?? []), { label: job.name.slice(slash + 3), job }]);
      continue;
    }
    const m = /^(.+?) \((.+)\)$/.exec(job.name);
    if (m) matrix.set(m[1]!, [...(matrix.get(m[1]!) ?? []), { label: m[2]!, job }]);
    else single.push(job);
  }
  const nodes: GraphNode[] = [];
  for (const [label, members] of reusable) nodes.push(summarize({ key: `name:reusable:${label}`, label, kind: "reusable", source: "job-name", members }));
  for (const [label, members] of matrix) {
    if (members.length >= 2) nodes.push(summarize({ key: `name:matrix:${label}`, label, kind: "matrix", source: "job-name", members }));
    else single.push(members[0]!.job);
  }
  for (const job of single) nodes.push(summarize({ key: `job:${job.id}`, label: job.name, kind: "job", source: "job-name", members: [{ label: job.name, job }] }));
  return nodes.sort(byStart);
}

// ---- entry point ---------------------------------------------------------------------------------

export type GraphContext = {
  run?: Pick<Run, "referenced_workflows">;
  /** Present when the workflow file was read: where it came from. */
  file?: { path: string; revision: string };
  /** Why there is no workflow definition (shown to the user). */
  unavailableReason?: string;
};

export function buildRunGraph(jobs: Job[], definition: WorkflowDefinition | null, context: GraphContext = {}): RunGraph {
  if (!definition || !context.file) {
    const notes = ["Jobs are shown without dependency edges, because dependencies come only from the workflow file."];
    if (nameBasedNodes(jobs).some((n) => n.kind !== "job")) notes.push("Matrix and reusable-workflow groups are based on job names only.");
    return {
      nodes: nameBasedNodes(jobs),
      edges: [],
      evidence: { kind: "unavailable", reason: context.unavailableReason ?? "The workflow file was not available.", notes },
    };
  }

  const notes = [...definition.problems];
  const matchers = definition.jobs.map(matcherFor);
  const assigned = new Map<string, GraphMember[]>(definition.jobs.map((d) => [d.id, []]));
  const unmatched: Job[] = [];
  let ambiguous = 0;

  for (const job of jobs) {
    const hits = matchers.map((m) => ({ m, match: m.regex.exec(job.name) })).filter((h): h is { m: Matcher; match: RegExpExecArray } => h.match !== null);
    const exact = hits.filter((h) => h.m.exact);
    const chosen = hits.length === 1 ? hits[0] : exact.length === 1 ? exact[0] : undefined;
    if (!chosen) {
      if (hits.length > 1) ambiguous++;
      unmatched.push(job);
      continue;
    }
    const wholeCall = Boolean(chosen.m.def.uses) && chosen.match[2] === undefined;
    assigned.get(chosen.m.def.id)!.push({ label: chosen.m.memberLabel(chosen.match, job), job, ...(wholeCall ? { wholeCall } : {}) });
  }

  const referenced = context.run?.referenced_workflows ?? [];
  const nodes: GraphNode[] = definition.jobs.map((def) => {
    const members = assigned.get(def.id)!;
    let resolvedWorkflow: GraphNode["resolvedWorkflow"];
    if (def.uses) {
      const target = def.uses.startsWith("./") ? `/${def.uses.slice(2).split("@")[0]}@` : `${def.uses.split("@")[0]}@`;
      const ref = referenced.find((r) => (def.uses!.startsWith("./") ? r.path.includes(target) : r.path.startsWith(target)));
      if (ref) resolvedWorkflow = { path: ref.path, sha: ref.sha };
    }
    const kind: GraphNode["kind"] = def.uses ? "reusable" : def.matrix ? "matrix" : "job";
    return summarize({
      key: `def:${def.id}`,
      label: def.name && !EXPR.test(def.name) ? def.name : def.id,
      kind,
      source: "workflow-file",
      yamlId: def.id,
      members,
      uses: def.uses,
      resolvedWorkflow,
      declaredOnly: members.length === 0,
      environment: def.environment,
      onFailure: runsOnFailure(def) || undefined,
      stepDefs: def.uses ? undefined : def.steps,
    });
  });

  const ids = new Set(definition.jobs.map((d) => d.id));
  const edges: GraphEdge[] = [];
  for (const def of definition.jobs) {
    for (const need of def.needs) {
      if (ids.has(need)) edges.push({ from: `def:${need}`, to: `def:${def.id}` });
      else notes.push(`Job \`${def.id}\` needs \`${need}\`, which the workflow file does not define; no edge is drawn.`);
    }
  }

  for (const job of unmatched) {
    nodes.push(summarize({ key: `job:${job.id}`, label: job.name, kind: "job", source: "job-name", members: [{ label: job.name, job }] }));
  }
  if (unmatched.length) {
    notes.push(
      `${unmatched.length} job${unmatched.length === 1 ? "" : "s"} could not be matched to the workflow file${ambiguous ? ` (${ambiguous} matched more than one job definition)` : ""}; shown without dependency edges.`,
    );
  }
  const declaredOnly = nodes.filter((n) => n.declaredOnly);
  if (declaredOnly.length) {
    notes.push(
      declaredOnly.length === 1
        ? "1 job is declared in the workflow file but has no matching job in this run."
        : `${declaredOnly.length} jobs are declared in the workflow file but have no matching job in this run.`,
    );
  }
  if (nodes.some((n) => n.kind === "reusable")) notes.push("Dependencies inside called (reusable) workflows are not shown.");

  return {
    nodes,
    edges,
    evidence: { kind: "workflow-file", path: context.file.path, revision: context.file.revision, matchedJobs: jobs.length - unmatched.length, totalJobs: jobs.length, notes },
  };
}

/**
 * The graph inside a reusable-workflow call: its jobs (named as in the called workflow) and, when the called
 * workflow file was read, the dependencies declared there. Without the file: jobs only, no edges.
 */
export function calledWorkflowGraph(node: GraphNode, inner: WorkflowDefinition | null, context: GraphContext): RunGraph {
  const jobs = node.members.filter((m) => !m.wholeCall).map((m) => ({ ...m.job, name: m.label }));
  return buildRunGraph(jobs, inner, context);
}

/** Duration in milliseconds between two ISO timestamps, or undefined if either is missing or out of order. */
export function durationMs(start?: string | null, end?: string | null): number | undefined {
  if (!start || !end) return undefined;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
