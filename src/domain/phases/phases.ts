// Release overview: groups a run's graph into logical phases (CI, Dev, Test, Stage, Prod…) and summarises
// each phase's progress, approval gate, failures, recovery and what is blocked. Pure: no I/O.
//
// Where grouping comes from (always shown to the user):
// - "declared": the repository's optional `.github/actions-ui-phases.yml` (a GitHub Actions UI convention;
//   GitHub itself has no notion of release phases);
// - "inferred": from `environment:` in the workflow files (including called workflows, and `${{ inputs.x }}`
//   filled from a caller's literal input). Other jobs join an environment only on evidence, recorded with its
//   provenance (see inferredGrouping); jobs before the first deployment are grouped by the top-level
//   reusable-workflow call they belong to;
// - otherwise no overview is offered and the raw execution graph is used.
// Phase-to-phase arrows are aggregated from real `needs` edges only. Nothing here invents dependencies.
import { jobStatus, type GraphEdge, type GraphNode, type NodeStatus, type RunGraph } from "../graph/build";
import { topLevelCall } from "../graph/hierarchy";
import type { WorkflowDefinition } from "../graph/workflow-definition";
import type { Job } from "../types";

export type PhaseKind = "build" | "deploy" | "validation" | "release" | "other";
export type JobRole = "build" | "deploy" | "validation" | "approval" | "recovery" | "other";
export type RoleEvidence = "declared" | "if: failure()" | "environment";

export type PhaseDeclaration = {
  id: string;
  name: string;
  kind: PhaseKind;
  environment?: string;
  jobs: Record<string, JobRole | undefined>;
  /** Optional labelled job groups within the phase (e.g. one per service), used as swimlanes. */
  groups?: Record<string, string[]>;
};
export type PhaseManifest = { file: string; phases: PhaseDeclaration[] };

// ---- manifest -------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const KINDS: PhaseKind[] = ["build", "deploy", "validation", "release", "other"];
const ROLES: JobRole[] = ["build", "deploy", "validation", "approval", "recovery", "other"];

/**
 * Reads `.github/actions-ui-phases.yml`:
 *   workflows:
 *     .github/workflows/release.yml:
 *       phases:
 *         - { id: dev, name: Dev, kind: deploy, environment: dev, jobs: { deploy-dev: deploy, smoke-dev: validation } }
 * Returns null when the file does not describe this workflow.
 */
export function readPhaseManifest(doc: unknown, workflowPath: string, file: string): PhaseManifest | { error: string } | null {
  if (!isRecord(doc) || !isRecord(doc.workflows)) return { error: "The phase file has no `workflows` mapping" };
  const entry = doc.workflows[workflowPath];
  if (entry === undefined) return null;
  if (!isRecord(entry) || !Array.isArray(entry.phases)) return { error: `The phase file entry for ${workflowPath} has no \`phases\` list` };
  const seen = new Set<string>();
  const phases: PhaseDeclaration[] = [];
  for (const raw of entry.phases) {
    if (!isRecord(raw) || typeof raw.id !== "string" || seen.has(raw.id)) return { error: "Each phase needs a unique `id`" };
    seen.add(raw.id);
    const jobs: Record<string, JobRole | undefined> = {};
    if (Array.isArray(raw.jobs)) for (const j of raw.jobs) if (typeof j === "string") jobs[j] = undefined;
    if (isRecord(raw.jobs)) for (const [j, role] of Object.entries(raw.jobs)) jobs[j] = ROLES.includes(role as JobRole) ? (role as JobRole) : undefined;
    phases.push({
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : raw.id,
      kind: KINDS.includes(raw.kind as PhaseKind) ? (raw.kind as PhaseKind) : "other",
      environment: typeof raw.environment === "string" ? raw.environment : undefined,
      jobs,
      groups: isRecord(raw.groups)
        ? Object.fromEntries(
            Object.entries(raw.groups)
              .filter(([, v]) => Array.isArray(v))
              .map(([k, v]) => [k, (v as unknown[]).filter((j): j is string => typeof j === "string")]),
          )
        : undefined,
    });
  }
  return { file, phases };
}

// ---- approval gates -------------------------------------------------------------------------------

export type ApprovalRecord = { state: "approved" | "rejected"; environments: string[]; user?: string; comment?: string };
export type PendingDeployment = { environment: string; reviewers: string[] };
export type GateState = {
  environment: string;
  state: "pending" | "approved" | "rejected";
  by?: string;
  comment?: string;
  reviewers?: string[];
  /** Which GitHub data established the state. */
  source: "approvals API" | "pending deployments API" | "job status";
};

export function gatesFor(graph: RunGraph, approvals: ApprovalRecord[] | null, pending: PendingDeployment[] | null): Map<string, GateState> {
  const gates = new Map<string, GateState>();
  for (const a of approvals ?? []) {
    for (const env of a.environments) {
      const prev = gates.get(env);
      if (!prev || a.state === "rejected") gates.set(env, { environment: env, state: a.state, by: a.user, comment: a.comment, source: "approvals API" });
    }
  }
  for (const p of pending ?? []) {
    if (!gates.has(p.environment)) gates.set(p.environment, { environment: p.environment, state: "pending", reviewers: p.reviewers, source: "pending deployments API" });
  }
  for (const n of graph.nodes) {
    if (n.environment && !gates.has(n.environment) && n.members.some((m) => jobStatus(m.job) === "waiting")) {
      gates.set(n.environment, { environment: n.environment, state: "pending", source: "job status" });
    }
  }
  return gates;
}

// ---- overview -------------------------------------------------------------------------------------

export type PhaseStatus =
  | "succeeded"
  | "failed"
  | "recovered"
  | "recovering"
  | "recovery-failed"
  | "rejected"
  | "awaiting-approval"
  | "running"
  | "pending"
  | "blocked"
  | "skipped"
  | "cancelled"
  | "not-started";

export type Phase = {
  id: string;
  name: string;
  kind: PhaseKind;
  environment?: string;
  nodeKeys: string[];
  status: PhaseStatus;
  /** Jobs that have finished (any conclusion) and all jobs in the phase. */
  done: number;
  total: number;
  failedKeys: string[];
  gate?: GateState;
  recovery?: "succeeded" | "failed" | "running" | "not-needed" | "none";
  blockedBy?: { phaseId: string; reason: string };
  startedAt?: string;
  completedAt?: string;
};

export type StopSummary = {
  kind: "failed" | "rejected" | "paused" | "cancelled";
  phaseId?: string;
  rootCauseKeys: string[];
  failedStep?: { jobId: number; step: string };
  affectedPhaseIds: string[];
  text: string;
};

export type ReleaseOverview = {
  source: "declared" | "inferred";
  sourceNote: string;
  phases: Phase[];
  phaseEdges: { from: string; to: string; count: number }[];
  unassignedKeys: string[];
  nodePhase: Map<string, string>;
  roles: Map<string, { role: JobRole; evidence: RoleEvidence }>;
  gates: Map<string, GateState>;
  /** Declared job groups (e.g. services), by node key. Empty when none are declared. */
  nodeGroup: Map<string, string>;
  /** Inferred grouping: each job's environment and its provenance (declared, input, heuristic, unknown). */
  environments: Map<string, NodeEnvironment>;
  stop?: StopSummary;
  notes: string[];
};

const FAILED: NodeStatus[] = ["failure", "timed_out"];
const DONE: NodeStatus[] = ["failure", "timed_out", "cancelled", "success", "neutral", "skipped"];

function ancestors(key: string, edges: GraphEdge[]): Map<string, number> {
  const dist = new Map<string, number>();
  let frontier = [key];
  for (let d = 1; frontier.length; d++) {
    const next: string[] = [];
    for (const k of frontier)
      for (const e of edges)
        if (e.to === k && !dist.has(e.from)) {
          dist.set(e.from, d);
          next.push(e.from);
        }
    frontier = next;
  }
  return dist;
}

function layerOf(graph: RunGraph): Map<string, number> {
  const layer = new Map<string, number>();
  const visit = (k: string, seen: Set<string>): number => {
    if (layer.has(k)) return layer.get(k)!;
    if (seen.has(k)) return 0;
    seen.add(k);
    const l = Math.max(-1, ...graph.edges.filter((e) => e.to === k).map((e) => visit(e.from, seen))) + 1;
    layer.set(k, l);
    return l;
  };
  graph.nodes.forEach((n) => visit(n.key, new Set()));
  return layer;
}

type Grouping = {
  source: "declared" | "inferred";
  note: string;
  decls: Omit<PhaseDeclaration, "jobs" | "groups">[];
  nodePhase: Map<string, string>;
  nodeGroup: Map<string, string>;
  declaredRoles: Map<string, JobRole>;
  notes: string[];
  /** Inferred grouping only: each job's environment, how it was established, and why. */
  environments?: Map<string, NodeEnvironment>;
};

function declaredGrouping(graph: RunGraph, manifest: PhaseManifest): Grouping {
  const byYaml = new Map(graph.nodes.filter((n) => n.yamlId).map((n) => [n.yamlId!, n.key]));
  const nodePhase = new Map<string, string>();
  const nodeGroup = new Map<string, string>();
  const declaredRoles = new Map<string, JobRole>();
  const notes: string[] = [];
  for (const p of manifest.phases) {
    for (const [label, jobIds] of Object.entries(p.groups ?? {})) {
      for (const jobId of jobIds) {
        const key = byYaml.get(jobId);
        if (key) nodeGroup.set(key, label);
      }
    }
    for (const [jobId, role] of Object.entries(p.jobs)) {
      const key = byYaml.get(jobId);
      if (!key) {
        notes.push(`The phase file lists job \`${jobId}\` in ${p.name}, but the workflow file has no such job.`);
        continue;
      }
      nodePhase.set(key, p.id);
      if (role) declaredRoles.set(key, role);
    }
  }
  return {
    source: "declared",
    note: `Phases declared in ${manifest.file} (a GitHub Actions UI convention in this repository; GitHub does not classify jobs into phases).`,
    decls: manifest.phases.map((p) => ({ id: p.id, name: p.name, kind: p.kind, environment: p.environment })),
    nodePhase,
    nodeGroup,
    declaredRoles,
    notes,
  };
}

/** How a job's environment (and so its phase) was established. */
export type EnvProvenance = "declared" | "input" | "heuristic" | "unknown";
export type NodeEnvironment = { environment?: string; provenance: EnvProvenance; reason: string };

/** The reusable-workflow call instance a node belongs to ("" for the run's own workflow). */
const instanceOf = (n: GraphNode) => (n.context?.path ?? []).join("/");
const within = (inner: string, outer: string) => outer === "" || inner === outer || inner.startsWith(`${outer}/`);
const callName = (n: GraphNode) => (n.context ? `“${n.context.labels.join(" › ")}”` : "the run's workflow");

/**
 * Inferred grouping. Evidence for a job's environment, strongest first:
 *   1. declared: its own `environment:` (a literal, or `${{ inputs.x }}` filled from the caller's literal);
 *   2. input: its reusable-workflow call passes a literal input whose value is one of the run's environments;
 *   3. heuristic (same call): it is in the same call instance as jobs that all deploy to one environment;
 *   4. heuristic (after a deployment): in the same workflow file, its nearest upstream deployments are all to one
 *      environment. This includes a job that the next environment's deployment needs (a change-record or readiness
 *      step): it stays with the environment it follows, and its reason names the environment it gates.
 * Jobs before any deployment are grouped by their top-level call, or as "Before deployment". Anything else is
 * unassigned, with the reason.
 */
function inferredGrouping(graph: RunGraph): Grouping | null {
  const fromFile = graph.nodes.filter((n) => n.source === "workflow-file");
  const envNodes = fromFile.filter((n) => n.environment);
  if (envNodes.length === 0) return null;
  const layer = layerOf(graph);
  const firstLayer = (e: string) => Math.min(...envNodes.filter((n) => n.environment === e).map((n) => layer.get(n.key)!));
  const envs = [...new Set(envNodes.map((n) => n.environment!))].sort((a, b) => firstLayer(a) - firstLayer(b));
  const byName = new Map(envs.map((e) => [e.toLowerCase(), e]));
  const nodes = new Map(graph.nodes.map((n) => [n.key, n]));
  const environments = new Map<string, NodeEnvironment>();
  const notes: string[] = [];

  for (const n of envNodes) {
    const e = n.environment!;
    environments.set(n.key, {
      environment: e,
      provenance: n.environmentEvidence === "input" ? "input" : "declared",
      reason:
        n.environmentEvidence !== "input"
          ? `\`environment: ${e}\` in its workflow file`
          : n.callId
            ? `the called workflow deploys only to \`${e}\``
            : `its \`environment:\` is an input that ${callName(n)} fills with \`${e}\``,
    });
  }

  // A job that deploys to an environment the run's data cannot resolve is never placed by a heuristic.
  for (const n of fromFile) {
    if (!environments.has(n.key) && n.environmentUnresolved)
      environments.set(n.key, { provenance: "unknown", reason: `it deploys to \`${n.environmentUnresolved}\`, which cannot be resolved from the run's data` });
  }

  // 2. A literal input of the call naming one environment.
  for (const n of fromFile) {
    if (environments.has(n.key)) continue;
    const inputs = { ...(n.context?.inputs ?? {}), ...(n.callInputs ?? {}) };
    const named = Object.entries(inputs).filter(([, v]) => byName.has(v.trim().toLowerCase()));
    const found = new Set(named.map(([, v]) => byName.get(v.trim().toLowerCase())!));
    if (found.size === 1) {
      const [k, v] = named[0]!;
      const e = [...found][0]!;
      environments.set(n.key, { environment: e, provenance: "input", reason: `${n.callInputs?.[k] !== undefined ? "the call" : callName(n)} is called with \`${k}: ${v}\`` });
    } else if (found.size > 1) notes.push(`${n.label}: its call passes several environment names (${[...found].join(", ")}), so none is used.`);
  }

  // 3. The call instance it is in deploys to exactly one environment.
  for (const n of fromFile) {
    if (environments.has(n.key) || !n.context) continue;
    const path = n.context.path;
    for (let depth = path.length; depth > 0; depth--) {
      const prefix = path.slice(0, depth).join("/");
      const found = new Set(envNodes.filter((x) => x.context && within(instanceOf(x), prefix)).map((x) => x.environment!));
      if (found.size === 0) continue;
      if (found.size === 1) {
        const e = [...found][0]!;
        environments.set(n.key, {
          environment: e,
          provenance: "heuristic",
          reason: `it declares no environment, and it is in the same reusable-workflow call (“${n.context.labels.slice(0, depth).join(" › ")}”) as the jobs that deploy to \`${e}\``,
        });
      }
      break;
    }
  }

  // 4. After deployments in the same workflow file; promotion gates; jobs before any deployment.
  const nodePhase = new Map<string, string>();
  let pre = false;
  const calls = new Map<string, { label: string; layer: number }>();
  const succs = (k: string) => graph.edges.filter((e) => e.from === k).map((e) => e.to);
  const ordered = [...fromFile].sort((a, b) => layer.get(a.key)! - layer.get(b.key)!);
  for (const n of ordered) {
    if (environments.has(n.key)) continue;
    const all = ancestors(n.key, graph.edges);
    const deployedBefore = [...all.keys()].some((k) => environments.get(k)?.environment);
    if (!deployedBefore) {
      const call = topLevelCall(n);
      if (call) {
        nodePhase.set(n.key, `call:${call.id}`);
        const prev = calls.get(call.id);
        calls.set(call.id, { label: call.label, layer: Math.min(prev?.layer ?? Infinity, layer.get(n.key) ?? 0) });
      } else {
        nodePhase.set(n.key, "pre");
        pre = true;
      }
      environments.set(n.key, { provenance: "unknown", reason: "it runs before any deployment" });
      continue;
    }
    const inst = instanceOf(n);
    // Only deployments with evidence of their own count (declared or from an input), not jobs placed by a heuristic.
    const deploys = (k: string) => ["declared", "input"].includes(environments.get(k)?.provenance ?? "") && environments.get(k)?.environment;
    const local = [...all].filter(([k]) => within(instanceOf(nodes.get(k)!), inst) && deploys(k));
    if (local.length === 0) {
      environments.set(n.key, { provenance: "unknown", reason: `it declares no environment, and the deployments it follows are in other reusable-workflow calls than ${callName(n)}` });
      continue;
    }
    const nearest = Math.min(...local.map(([, d]) => d));
    const near = local.filter(([, d]) => d === nearest).map(([k]) => k);
    const found = new Set(near.map((k) => environments.get(k)!.environment!));
    if (found.size > 1) {
      environments.set(n.key, { provenance: "unknown", reason: `it declares no environment, and it runs after deployments to ${[...found].map((e) => `\`${e}\``).join(" and ")}` });
      continue;
    }
    const e = [...found][0]!;
    const gated = [...new Set(succs(n.key).map((k) => environments.get(k)?.environment).filter((x): x is string => !!x && x !== e))].sort((a, b) => envs.indexOf(a) - envs.indexOf(b));
    const via = nodes.get(near[0]!)!.label;
    environments.set(n.key, {
      environment: e,
      provenance: "heuristic",
      reason: `it declares no environment, and it runs after “${via}”, which deploys to \`${e}\`, in the same workflow${gated.length ? `; the \`${gated.join("`, `")}\` deployment needs it` : ""}`,
    });
  }

  for (const [k, v] of environments) if (v.environment) nodePhase.set(k, `env:${v.environment}`);

  const decls: Grouping["decls"] = [
    ...[...calls].sort((a, b) => a[1].layer - b[1].layer).map(([id, c]) => ({ id: `call:${id}`, name: c.label, kind: "other" as const })),
    ...(pre ? [{ id: "pre", name: "Before deployment", kind: "build" as const }] : []),
    ...envs.map((e) => ({ id: `env:${e}`, name: e, kind: "deploy" as const, environment: e })),
  ];
  const heuristic = [...environments.values()].some((v) => v.provenance === "heuristic");
  return {
    source: "inferred",
    note: `Phases inferred from \`environment:\` in the workflow file${graph.nodes.some((n) => n.context) ? "s, including called workflows" : ""}: each environment is a phase. A job without its own environment joins one only on evidence: a literal input of its reusable-workflow call naming the environment${heuristic ? ", or (marked as inferred) the call it is in, or the deployment it follows in the same workflow" : ""}${calls.size ? "; jobs before the first deployment are grouped by the reusable workflow call they belong to" : ""}. GitHub does not classify jobs into phases.`,
    decls,
    nodePhase,
    nodeGroup: new Map(),
    declaredRoles: new Map(),
    notes,
    environments,
  };
}

export function buildOverview(
  graph: RunGraph,
  definition: WorkflowDefinition | null,
  options: { manifest?: PhaseManifest | null; gates?: Map<string, GateState> },
): ReleaseOverview | { unavailable: string } {
  if (graph.evidence.kind !== "workflow-file" || !definition) {
    return { unavailable: "No workflow file, so jobs cannot be grouped into phases. The execution graph shows the jobs GitHub reported." };
  }
  const grouping = options.manifest ? declaredGrouping(graph, options.manifest) : inferredGrouping(graph);
  if (!grouping) {
    const unread = graph.nodes.some((n) => n.callId && !n.resolvedWorkflow);
    return {
      unavailable: unread
        ? "No deployment environments were found, but some called workflows could not be read, so environments inside them are unknown (see the execution graph's notes)."
        : "This workflow declares no phases and no deployment environments, so there is no reliable way to group its jobs. Use the execution graph.",
    };
  }
  const gates = options.gates ?? new Map<string, GateState>();
  const nodes = new Map(graph.nodes.map((n) => [n.key, n]));

  // Roles: declared first, then facts from the workflow file.
  const roles = new Map<string, { role: JobRole; evidence: RoleEvidence }>();
  for (const n of graph.nodes) {
    const declared = grouping.declaredRoles.get(n.key);
    if (declared) roles.set(n.key, { role: declared, evidence: "declared" });
    else if (n.onFailure) roles.set(n.key, { role: "recovery", evidence: "if: failure()" });
    else if (n.environment) roles.set(n.key, { role: "deploy", evidence: "environment" });
  }
  const isRecovery = (k: string) => roles.get(k)?.role === "recovery";

  const phaseEdgeCount = new Map<string, number>();
  for (const e of graph.edges) {
    const a = grouping.nodePhase.get(e.from);
    const b = grouping.nodePhase.get(e.to);
    if (a && b && a !== b) phaseEdgeCount.set(`${a}\u0000${b}`, (phaseEdgeCount.get(`${a}\u0000${b}`) ?? 0) + 1);
  }
  const phaseEdges = [...phaseEdgeCount].map(([k, count]) => {
    const [from, to] = k.split("\u0000") as [string, string];
    return { from, to, count };
  });

  // Phase statuses, in declared order (upstream phases first for blocked attribution).
  const phases: Phase[] = [];
  for (const decl of grouping.decls) {
    const keys = graph.nodes.filter((n) => grouping.nodePhase.get(n.key) === decl.id).map((n) => n.key);
    const pn = keys.map((k) => nodes.get(k)!);
    const main = pn.filter((n) => !isRecovery(n.key));
    const recovery = pn.filter((n) => isRecovery(n.key));
    const statuses = main.map((n) => n.status);
    const envs = new Set([decl.environment, ...pn.map((n) => n.environment)].filter((e): e is string => !!e));
    const phaseGates = [...envs].map((e) => gates.get(e)).filter((g): g is GateState => !!g);
    const gate = phaseGates.find((g) => g.state === "rejected") ?? phaseGates.find((g) => g.state === "pending") ?? phaseGates[0];
    const failedKeys = main.filter((n) => FAILED.includes(n.status)).map((n) => n.key);
    const ran = recovery.filter((n) => n.status !== "skipped" && n.status !== "not_run");

    let status: PhaseStatus;
    let rec: Phase["recovery"] = recovery.length ? "not-needed" : "none";
    if (gate?.state === "rejected") status = "rejected";
    else if (failedKeys.length) {
      if (ran.some((n) => FAILED.includes(n.status))) [status, rec] = ["recovery-failed", "failed"];
      else if (ran.some((n) => ["in_progress", "queued", "waiting"].includes(n.status))) [status, rec] = ["recovering", "running"];
      else if (ran.length && ran.every((n) => n.status === "success")) [status, rec] = ["recovered", "succeeded"];
      else status = "failed";
    } else if (statuses.includes("cancelled")) status = "cancelled";
    else if (gate?.state === "pending" || statuses.includes("waiting")) status = "awaiting-approval";
    else if (statuses.some((s) => s === "in_progress" || s === "queued")) status = "running";
    else if (statuses.length && statuses.every((s) => s === "skipped" || s === "not_run")) status = statuses.every((s) => s === "not_run") ? "not-started" : "skipped";
    else if (statuses.some((s) => s === "not_run")) status = "running";
    else status = "succeeded";

    const members = pn.flatMap((n) => n.members.map((m) => m.job));
    const starts = members.map((j) => j.started_at).filter((t): t is string => !!t).sort();
    const ends = members.map((j) => j.completed_at).filter((t): t is string => !!t).sort();
    phases.push({
      id: decl.id,
      name: decl.name,
      kind: decl.kind,
      environment: decl.environment,
      nodeKeys: keys,
      status,
      done: members.filter((j) => DONE.includes(jobStatus(j))).length,
      total: members.length + pn.filter((n) => n.declaredOnly).length,
      failedKeys,
      gate,
      recovery: rec,
      startedAt: starts[0],
      completedAt: status === "succeeded" || status === "failed" || status === "recovered" || status === "recovery-failed" ? ends.at(-1) : undefined,
    });
  }

  // Blocked or pending phases: attribute them to the nearest upstream phase with a problem.
  const byId = new Map(phases.map((p) => [p.id, p]));
  const problem = (p: Phase) => ["failed", "recovered", "recovery-failed", "recovering", "rejected", "cancelled", "awaiting-approval", "running", "blocked", "pending"].includes(p.status);
  for (const p of phases) {
    if (p.status !== "not-started" && p.status !== "skipped") continue;
    let frontier = [p.id];
    const seen = new Set(frontier);
    let cause: Phase | undefined;
    while (frontier.length && !cause) {
      const next: string[] = [];
      for (const id of frontier)
        for (const e of phaseEdges)
          if (e.to === id && !seen.has(e.from)) {
            seen.add(e.from);
            next.push(e.from);
          }
      cause = next.map((id) => byId.get(id)!).find(problem);
      frontier = next;
    }
    if (!cause) continue;
    const terminal = ["failed", "recovered", "recovery-failed", "rejected", "cancelled"].includes(cause.status) || (cause.status === "blocked" && cause.blockedBy);
    const root = cause.blockedBy ? byId.get(cause.blockedBy.phaseId)! : cause;
    p.status = terminal ? "blocked" : "pending";
    p.blockedBy = { phaseId: root.id, reason: `${root.name}: ${PHASE_STATUS_TEXT[root.status].toLowerCase()}` };
  }

  // Why execution stopped (or paused).
  let stop: StopSummary | undefined;
  // A job that "failed" because its deployment was rejected is reported as the rejection, not as a failure.
  const rejectedEnv = (n: GraphNode) => !!n.environment && gates.get(n.environment)?.state === "rejected";
  const failedRoots = graph.nodes.filter(
    (n) => FAILED.includes(n.status) && !isRecovery(n.key) && !rejectedEnv(n) && ![...ancestors(n.key, graph.edges).keys()].some((a) => FAILED.includes(nodes.get(a)!.status)),
  );
  const affected = phases.filter((p) => p.status === "blocked" || p.status === "pending").map((p) => p.id);
  const phaseName = (key: string) => byId.get(grouping.nodePhase.get(key) ?? "")?.name;
  if (failedRoots.length) {
    const first = failedRoots[0]!;
    const job = first.members.find((m) => FAILED.includes(jobStatus(m.job)))?.job;
    const step = job ? failedStep(job) : undefined;
    const where = phaseName(first.key);
    const recoveryPhase = phases.find((p) => p.failedKeys.includes(first.key));
    const recoveryText =
      recoveryPhase?.recovery === "succeeded" ? " Recovery jobs ran and succeeded." : recoveryPhase?.recovery === "failed" ? " A recovery job also failed." : "";
    stop = {
      kind: "failed",
      phaseId: grouping.nodePhase.get(first.key),
      rootCauseKeys: failedRoots.map((n) => n.key),
      failedStep: job && step ? { jobId: job.id, step } : undefined,
      affectedPhaseIds: affected,
      text: `Stopped${where ? ` in ${where}` : ""}: ${job?.name ?? first.label} failed${step ? ` at step “${step}”` : ""}.${recoveryText}${
        affected.length ? ` Not run as a result: ${affected.map((id) => byId.get(id)!.name).join(", ")}.` : ""
      }`,
    };
  } else {
    const rejected = phases.find((p) => p.status === "rejected");
    const waiting = phases.find((p) => p.status === "awaiting-approval");
    const cancelled = phases.find((p) => p.status === "cancelled");
    if (rejected) {
      stop = {
        kind: "rejected",
        phaseId: rejected.id,
        rootCauseKeys: [],
        affectedPhaseIds: affected,
        text: `Stopped: the ${rejected.gate?.environment ?? rejected.name} deployment was rejected${rejected.gate?.by ? ` by ${rejected.gate.by}` : ""}.${
          affected.length ? ` Not run as a result: ${affected.map((id) => byId.get(id)!.name).join(", ")}.` : ""
        }`,
      };
    } else if (waiting) {
      stop = {
        kind: "paused",
        phaseId: waiting.id,
        rootCauseKeys: [],
        affectedPhaseIds: affected,
        text: `Paused: the ${waiting.gate?.environment ?? waiting.name} deployment is awaiting approval${waiting.gate?.reviewers?.length ? ` (${waiting.gate.reviewers.join(", ")})` : ""}.${
          affected.length ? ` Waiting on it: ${affected.map((id) => byId.get(id)!.name).join(", ")}.` : ""
        }`,
      };
    } else if (cancelled) {
      stop = { kind: "cancelled", phaseId: cancelled.id, rootCauseKeys: [], affectedPhaseIds: affected, text: `Cancelled in ${cancelled.name}.` };
    }
  }

  const unassignedKeys = graph.nodes.filter((n) => !grouping.nodePhase.has(n.key)).map((n) => n.key);
  const notes = [...grouping.notes];
  if (unassignedKeys.length) notes.push(`${unassignedKeys.length} job group${unassignedKeys.length === 1 ? " is" : "s are"} not in any phase; see “Other jobs”.`);
  return {
    source: grouping.source,
    sourceNote: grouping.note,
    phases,
    phaseEdges,
    unassignedKeys,
    nodePhase: grouping.nodePhase,
    nodeGroup: grouping.nodeGroup,
    environments: grouping.environments ?? new Map(),
    roles,
    gates,
    stop,
    notes,
  };
}

export function failedStep(job: Job): string | undefined {
  return job.steps?.find((s) => s.status === "completed" && (s.conclusion === "failure" || s.conclusion === "timed_out"))?.name;
}

export const PHASE_STATUS_TEXT: Record<PhaseStatus, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  recovered: "Failed · rolled back",
  recovering: "Failed · recovering",
  "recovery-failed": "Failed · recovery failed",
  rejected: "Approval rejected",
  "awaiting-approval": "Awaiting approval",
  running: "Running",
  pending: "Waiting on upstream",
  blocked: "Blocked",
  skipped: "Skipped",
  cancelled: "Cancelled",
  "not-started": "Not started",
};

export type PhaseScope = {
  /** Dependencies between jobs inside the phase. */
  internalEdges: number;
  /** Neighbouring phases, with the jobs outside this phase that are directly connected to it. */
  upstream: { phaseId?: string; phaseName: string; jobs: string[] }[];
  downstream: { phaseId?: string; phaseName: string; jobs: string[] }[];
};

/**
 * The focused graph for one phase: its jobs and the real dependencies among them. Jobs in other phases that
 * are directly connected are summarised as one node per neighbouring phase and direction ("Test: 7
 * prerequisite jobs"), linked to each job here that has such a dependency. Nothing is dropped silently:
 * the scope lists every summarised job.
 */
export function phaseGraph(graph: RunGraph, overview: ReleaseOverview, phaseId: string): RunGraph & { scope: PhaseScope } {
  const inPhase = new Set(overview.phases.find((p) => p.id === phaseId)?.nodeKeys ?? (phaseId === "other" ? overview.unassignedKeys : []));
  const nodes = new Map(graph.nodes.map((n) => [n.key, n]));
  const phaseOf = (key: string) => overview.nodePhase.get(key) ?? (overview.unassignedKeys.includes(key) ? "other" : undefined);
  const nameOf = (id?: string) => overview.phases.find((p) => p.id === id)?.name ?? "Other jobs";
  const summaries = new Map<string, { node: GraphNode; keys: Set<string> }>();
  const edges = new Map<string, GraphEdge>();
  const add = (e: GraphEdge) => edges.set(`${e.from}->${e.to}`, e);
  let internalEdges = 0;
  for (const e of graph.edges) {
    const fromIn = inPhase.has(e.from);
    const toIn = inPhase.has(e.to);
    if (fromIn && toIn) {
      add(e);
      internalEdges++;
      continue;
    }
    if (!fromIn && !toIn) continue;
    const outside = fromIn ? e.to : e.from;
    const direction = fromIn ? "downstream" : "upstream";
    const otherPhase = phaseOf(outside);
    const key = `ext:${direction}:${otherPhase ?? "other"}`;
    if (!summaries.has(key)) {
      summaries.set(key, {
        node: {
          key,
          label: nameOf(otherPhase),
          kind: "job",
          source: "workflow-file",
          members: [],
          status: "unknown",
          counts: {},
          external: { key: outside, phaseId: otherPhase, phaseName: nameOf(otherPhase), direction, jobs: [] },
        },
        keys: new Set(),
      });
    }
    summaries.get(key)!.keys.add(outside);
    add(fromIn ? { from: e.from, to: key } : { from: key, to: e.to });
  }
  const ORDER: NodeStatus[] = ["failure", "timed_out", "cancelled", "in_progress", "waiting", "queued", "success", "neutral", "skipped", "not_run"];
  const stubs = [...summaries.values()].map(({ node, keys }) => {
    const members = [...keys].map((k) => nodes.get(k)!);
    const status = ORDER.find((s) => members.some((m) => m.status === s)) ?? "unknown";
    return { ...node, status, external: { ...node.external!, jobs: members.map((m) => m.label).sort() } };
  });
  const scopeOf = (direction: "upstream" | "downstream") =>
    stubs.filter((n) => n.external!.direction === direction).map((n) => ({ phaseId: n.external!.phaseId, phaseName: n.external!.phaseName, jobs: n.external!.jobs! }));
  return {
    nodes: [...graph.nodes.filter((n) => inPhase.has(n.key)), ...stubs],
    edges: [...edges.values()],
    evidence: graph.evidence,
    scope: { internalEdges, upstream: scopeOf("upstream"), downstream: scopeOf("downstream") },
  };
}
