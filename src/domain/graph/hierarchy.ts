// The reusable-workflow hierarchy of a run, and the execution graph built from it. Pure: no I/O.
//
// Evidence, kept apart:
// - what executed: GitHub's jobs API. Jobs inside calls are named "<call> / <job>", one segment per level;
// - what each workflow declares: its file, read at a revision established from GitHub's own data
//   (`referenced_workflows`), a pinned commit SHA, or, for `./` references, the commit of the workflow that
//   contains the reference (GitHub's rule). A branch or tag that GitHub did not resolve is NOT read;
// - environments: `environment:` in a file, or `${{ inputs.x }}` filled from a caller's literal `with:` value.
//
// A call is expanded into its jobs when it deploys to environments (so the release overview can group them by
// environment); other calls stay one node that opens as its own context. Inside each workflow, edges come only
// from that file's `needs:`. A caller-level `needs` (e.g. `cd` needs `ci`) is kept as its own kind of edge
// (`via: "call"`), drawn from the last jobs of one call to the first jobs of the other.
import type { Job, Run } from "../types";
import { buildRunGraph, type GraphEdge, type GraphEvidence, type GraphNode, type NodeContext, type RunGraph, type WorkflowFileRef } from "./build";
import type { WorkflowDefinition, WorkflowJobDef } from "./workflow-definition";

export type CallTarget = { kind: "local"; path: string } | { kind: "remote"; repo: string; path: string; ref: string };

/** Parses a job-level `uses:`. Returns null for anything that is not a reusable-workflow file reference. */
export function parseUses(uses: string): CallTarget | null {
  if (uses.startsWith("./")) {
    const path = uses.slice(2).split("@")[0]!;
    return /\.ya?ml$/.test(path) ? { kind: "local", path } : null;
  }
  const m = /^([^/\s@]+)\/([^/\s@]+)\/([^@\s]+\.ya?ml)@(\S+)$/.exec(uses);
  return m ? { kind: "remote", repo: `${m[1]}/${m[2]}`, path: m[3]!, ref: m[4]! } : null;
}

export type CallResolution = { file: WorkflowFileRef } | { unresolved: string };

/** Which file, at which revision, a call ran — or why that cannot be established. */
export function resolveCall(uses: string, parent: WorkflowFileRef, referenced: Run["referenced_workflows"]): CallResolution {
  const target = parseUses(uses);
  if (!target) return { unresolved: `\`${uses}\` is not a reusable-workflow file reference.` };
  if (target.kind === "local") {
    // GitHub reads a `./` reference from the same repository and commit as the workflow containing it.
    return { file: { repo: parent.repo, path: target.path, revision: parent.revision, source: parent.source === "run-commit" ? "run-commit" : "caller-commit" } };
  }
  const wanted = `${target.repo}/${target.path}@${target.ref}`.toLowerCase();
  const reported = (referenced ?? []).filter((r) => r.path.toLowerCase() === wanted && /^[0-9a-f]{40}$/i.test(r.sha));
  const shas = [...new Set(reported.map((r) => r.sha.toLowerCase()))];
  if (shas.length === 1) return { file: { repo: target.repo, path: target.path, revision: shas[0]!, source: "referenced-workflows" } };
  if (shas.length > 1) return { unresolved: `GitHub reported more than one commit for \`${target.ref}\` of ${target.repo}/${target.path}, so the revision is ambiguous.` };
  if (/^[0-9a-f]{40}$/i.test(target.ref)) return { file: { repo: target.repo, path: target.path, revision: target.ref.toLowerCase(), source: "pinned-sha" } };
  return {
    unresolved: `GitHub did not report which commit \`${target.ref}\` of ${target.repo}/${target.path} resolved to in this run. A branch or tag may have moved since, so the file is not read.`,
  };
}

/** A workflow and the workflows it calls, by calling job id. `definition` is null when the file was not read. */
export type WorkflowTree = { file?: WorkflowFileRef; definition: WorkflowDefinition | null; unavailable?: string; calls: Map<string, WorkflowTree> };

export const fileKey = (f: Pick<WorkflowFileRef, "repo" | "path" | "revision">) => `${f.repo.toLowerCase()}@${f.revision.toLowerCase()}:${f.path}`;

/** The tree node for a call id ("cd/deploy-dev"), if it was loaded. */
export function treeAt(tree: WorkflowTree, callId: string): WorkflowTree | undefined {
  let t: WorkflowTree | undefined = tree;
  for (const id of callId.split("/")) t = t?.calls.get(id);
  return t;
}

// ---- inputs and environments ---------------------------------------------------------------------

const WHOLE_INPUT = /^\$\{\{\s*inputs\.([A-Za-z0-9_-]+)\s*\}\}$/;

/** A value with `${{ inputs.x }}` filled from known literal inputs; undefined if it cannot be resolved exactly. */
function fill(value: string | undefined, inputs: Record<string, string>): string | undefined {
  if (value === undefined || !value.includes("${{")) return value;
  const m = WHOLE_INPUT.exec(value.trim());
  const v = m ? inputs[m[1]!] : undefined;
  return v !== undefined && !v.includes("${{") ? v : undefined;
}

function inputsFor(job: WorkflowJobDef, inputs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(job.with ?? {})) {
    const f = fill(v, inputs);
    if (f !== undefined) out[k] = f;
  }
  return out;
}

/** Environments a workflow (and the workflows it calls) declares, with the given literal inputs. */
export function environmentsOf(tree: WorkflowTree, inputs: Record<string, string>, depth = 0): Set<string> {
  const out = new Set<string>();
  if (!tree.definition || depth > 20) return out;
  for (const j of tree.definition.jobs) {
    const env = fill(j.environment, inputs);
    if (env) out.add(env);
    const child = j.uses ? tree.calls.get(j.id) : undefined;
    if (child) for (const e of environmentsOf(child, inputsFor(j, inputs), depth + 1)) out.add(e);
  }
  return out;
}

// ---- flattening ----------------------------------------------------------------------------------

const QUALIFIED = /^(def:|name:reusable:|name:matrix:)(.*)$/;
const qualify = (key: string, path: string[]) => {
  const m = QUALIFIED.exec(key);
  return path.length && m ? `${m[1]}${path.join("/")}/${m[2]}` : key;
};

type Level = { nodes: GraphNode[]; edges: GraphEdge[]; notes: string[]; evidence: GraphEvidence; expanded: number; collapsed: number };
const EMPTY: WorkflowTree = { definition: null, calls: new Map() };

// Jobs are matched to each called file by their name relative to the call ("cd / DEV / Deploy" -> "Deploy");
// `originals` restores GitHub's own job objects (full names) on the nodes.
function level(
  jobs: Job[],
  tree: WorkflowTree,
  ctx: NodeContext | undefined,
  inputs: Record<string, string>,
  run: Pick<Run, "referenced_workflows"> | undefined,
  depth: number,
  originals: Map<number, Job>,
): Level {
  const def = tree.definition;
  const g: RunGraph = buildRunGraph(jobs, def, def && tree.file ? { run, file: { path: tree.file.path, revision: tree.file.revision } } : { unavailableReason: tree.unavailable });
  const path = ctx?.path ?? [];
  const where = ctx ? ctx.labels.join(" › ") : "";
  const notes: string[] = ctx ? g.evidence.notes.filter((n) => !n.startsWith("Dependencies inside called")).map((n) => `${where}: ${n}`) : [];
  if (ctx && !def && jobs.length) notes.push(`${where}: ${tree.unavailable ?? "the called workflow was not read"} Its jobs are shown without dependencies.`);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const expansions = new Map<string, { sources: string[]; sinks: string[] }>();
  let expanded = 0;
  let collapsed = 0;

  for (const original of g.nodes) {
    const members = original.members.map((m) => ({ ...m, job: originals.get(m.job.id) ?? m.job }));
    const n: GraphNode = { ...original, members, key: qualify(original.key, path), ...(ctx ? { context: ctx } : {}) };
    const jd = n.yamlId ? def?.jobs.find((j) => j.id === n.yamlId) : undefined;
    if (jd?.environment !== undefined) {
      const env = fill(jd.environment, inputs);
      n.environment = env;
      n.environmentEvidence = env === undefined ? undefined : env === jd.environment ? "declared" : "input";
      if (env === undefined) n.environmentUnresolved = jd.environment;
      if (env === undefined) notes.push(`${where ? `${where}: ` : ""}job \`${jd.id}\` deploys to \`${jd.environment}\`, which cannot be resolved from the run's data, so it is not used for grouping.`);
    }
    if (n.kind !== "reusable" || !jd?.uses) {
      nodes.push(n);
      continue;
    }

    const child = tree.calls.get(jd.id);
    n.resolvedWorkflow = child?.file ? { path: `${child.file.repo}/${child.file.path}@${child.file.revision}`, sha: child.file.revision } : undefined;
    if (child?.file) n.callFile = child.file;
    if (child?.unavailable) n.callUnavailable = child.unavailable;
    const childInputs = inputsFor(jd, inputs);
    const callPath = [...path, jd.id];
    const inner = original.members.filter((m) => !m.wholeCall);
    const whole = n.members.some((m) => m.wholeCall);
    if (Object.keys(childInputs).length) n.callInputs = childInputs;
    const childCtx: NodeContext = { path: callPath, labels: [...(ctx?.labels ?? []), n.label], files: [...(ctx?.files ?? []), child?.file], environmentInput: childInputs.environment, inputs: childInputs };
    const envs = child ? environmentsOf(child, childInputs) : new Set<string>();
    const deploys = envs.size > 0 || childInputs.environment !== undefined;
    const canExpand = !jd.matrix && !whole && deploys && (inner.length > 0 || Boolean(child?.definition)) && depth < 20;
    const sub = canExpand ? level(inner.map((m) => ({ ...m.job, name: m.label })), child ?? EMPTY, childCtx, childInputs, run, depth + 1, originals) : undefined;

    if (!sub || sub.nodes.length === 0) {
      // One node for the call; it opens as its own context. A call that did not run still shows where it would
      // have deployed when its file names exactly one environment.
      n.callId = callPath.join("/");
      if (!n.environment && envs.size === 1) {
        n.environment = [...envs][0];
        n.environmentEvidence = "input";
      }
      const unresolved = envs.size === 0 ? child?.definition?.jobs.find((j) => j.environment !== undefined && fill(j.environment, childInputs) === undefined)?.environment : undefined;
      if (!n.environment && unresolved) n.environmentUnresolved = unresolved;
      if (child?.unavailable) notes.push(`${[...childCtx.labels].join(" › ")}: ${child.unavailable}`);
      nodes.push(n);
      collapsed++;
      continue;
    }
    expanded += 1 + sub.expanded;
    collapsed += sub.collapsed;
    nodes.push(...sub.nodes);
    edges.push(...sub.edges);
    notes.push(...sub.notes);
    const to = new Set(sub.edges.map((e) => e.to));
    const from = new Set(sub.edges.map((e) => e.from));
    expansions.set(n.key, { sources: sub.nodes.filter((x) => !to.has(x.key)).map((x) => x.key), sinks: sub.nodes.filter((x) => !from.has(x.key)).map((x) => x.key) });
  }

  for (const e of g.edges) {
    const f = qualify(e.from, path);
    const t = qualify(e.to, path);
    const fx = expansions.get(f);
    const tx = expansions.get(t);
    for (const a of fx?.sinks ?? [f]) for (const b of tx?.sources ?? [t]) edges.push({ from: a, to: b, ...(fx || tx ? { via: "call" as const } : {}) });
  }
  return { nodes, edges, notes, evidence: g.evidence, expanded, collapsed };
}

/** The run's execution graph across reusable-workflow calls (see the header for what is expanded and why). */
export function buildHierarchyGraph(jobs: Job[], tree: WorkflowTree, run?: Pick<Run, "referenced_workflows">): RunGraph {
  const root = level(jobs, tree, undefined, {}, run, 0, new Map(jobs.map((j) => [j.id, j])));
  const evidence = root.evidence;
  const notes = evidence.notes.filter((n) => !n.startsWith("Dependencies inside called"));
  if (root.expanded) {
    notes.push(
      `Jobs inside ${root.expanded} called workflow${root.expanded === 1 ? "" : "s"} that deploy to environments are shown with the dependencies declared in those files. A caller-level \`needs\` between calls is drawn as a dash-dot line.`,
    );
  }
  if (root.collapsed) notes.push(`${root.collapsed} reusable-workflow call${root.collapsed === 1 ? " is" : "s are"} shown as one node; open one to see its jobs and dependencies.`);
  notes.push(...root.notes);
  return { nodes: root.nodes, edges: root.edges, evidence: { ...evidence, notes } };
}

/** The top-level call a node belongs to (its own id for a call node at the top level). */
export function topLevelCall(node: GraphNode): { id: string; label: string } | undefined {
  if (node.context) return { id: node.context.path[0]!, label: node.context.labels[0]! };
  if (node.kind === "reusable" && node.yamlId) return { id: node.yamlId, label: node.label };
  return undefined;
}

/** Describes where a revision came from, for the UI. */
export const REVISION_TEXT: Record<WorkflowFileRef["source"], string> = {
  "run-commit": "the run's commit",
  "referenced-workflows": "the commit GitHub reported for this run",
  "pinned-sha": "the commit SHA pinned in `uses:`",
  "caller-commit": "the calling workflow's commit (GitHub's rule for `./` references)",
};
